// Session lifecycle hook.
//
// Owns: join, leave, reconnect state machine, config loading, mic/camera track
// management, engine switch, display-name sync to SFU, camera publish/stop.
//
// Does NOT own: mute/deafen boolean state (RoomPage), status messages for
// engine switch (caller wraps switchEngine in try/catch).

import { useRef, useEffect, useCallback } from 'react';
import { useStore } from '../store/useStore';
import { useScreenShareStore } from '../store/useScreenShareStore';
import { useCameraStore } from '../store/useCameraStore';
import { useAudioEngine } from './useAudioEngine';
import { preloadEngine, isEngineReady, formatEngine } from '../audio/engine';
import { useSFU } from './useSFU';
import { saveDisplayName, loadOrCreateClientId } from '../utils/storage';
import type { ChatPayload, ChatDeletedPayload, Attachment } from '../sfu/protocol';
import type { ShareMode } from '../screenshare/params';
import { SCREEN_SHARE_NO_CODEC } from '../sfu/client';
import { loadAppConfig, buildWsUrl } from '../config';
import { createReconnectScheduler } from '../utils/reconnect';
import { errorName } from '../utils/mediaError';
import { buildSFUHandlers } from './sfu-handlers';
import type { EngineKind, ParticipantUI } from '../types';
import type { MicGraph } from '../audio/mic-graph';

type UseSessionManagerDeps = {
  audio: ReturnType<typeof useAudioEngine>;
  sfu: ReturnType<typeof useSFU>;
  roomSlug: string;
};

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000] as const;

// On Android a camera NotAllowedError is usually the browser app lacking the OS
// camera permission (or the system Camera-access toggle being off), not a
// per-site block — sending users to "site settings" lands them on an empty
// page. We can't tell the layers apart from JS (all yield NotAllowedError), but
// we can point Android users at the right places.
const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

export function useSessionManager({ audio, sfu, roomSlug }: UseSessionManagerDeps) {
  const getStore = useStore.getState;

  const micGraphRef = useRef<MicGraph | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const clientIdRef = useRef<string>(loadOrCreateClientId());

  const userLeavingRef = useRef<boolean>(false);
  const lastDisplayNameRef = useRef<string>('');

  const configRef = useRef<{ iceServers: RTCIceServer[] } | null>(null);

  const connectSfuRef = useRef<(graph: MicGraph, display: string) => Promise<void>>(async () => {
    throw new Error('connectSfu not yet initialised');
  });

  const getPeerId = useCallback((): string | null => peerIdRef.current, []);

  const setMicEnabled = useCallback(
    (enabled: boolean): void => {
      const graph = micGraphRef.current;
      if (!graph) return;
      for (const track of graph.processedLocalStream.getAudioTracks()) {
        track.enabled = enabled;
      }
      const pid = peerIdRef.current;
      if (pid) {
        getStore().updateParticipant(pid, {
          selfMuted: !enabled,
          speaking: !enabled ? false : undefined,
        });
      }
    },
    [getStore],
  );

  const attachSpeakingLoop = useCallback(
    (graph: MicGraph): void => {
      audio.startSpeaking(
        graph,
        () => useStore.getState().selfMuted,
        (speaking) => {
          const pid = peerIdRef.current;
          if (!pid) return;
          const current = useStore.getState().participants[pid];
          if (current && current.speaking !== speaking) {
            getStore().updateParticipant(pid, { speaking });
          }
        },
      );
    },
    [audio, getStore],
  );

  const switchEngine = useCallback(
    async (engine: EngineKind): Promise<void> => {
      const graph = await audio.rebuildLocalAudio(engine, useStore.getState().selfMuted, () =>
        sfu.getPeerConnection(),
      );
      micGraphRef.current = graph;
      attachSpeakingLoop(graph);
    },
    [audio, sfu, attachSpeakingLoop],
  );

  const switchMicDevice = useCallback(async (): Promise<void> => {
    const s = useStore.getState();
    const graph = await audio.switchMicDevice(s.engine, s.selfMuted, () => sfu.getPeerConnection());
    micGraphRef.current = graph;
    attachSpeakingLoop(graph);
  }, [audio, sfu, attachSpeakingLoop]);

  const setRemoteDisplayName = useCallback(
    (name: string): void => {
      lastDisplayNameRef.current = name;
      if (name.trim()) saveDisplayName(name.trim());
      sfu.getClient()?.setDisplayName(name);
      const pid = peerIdRef.current;
      if (pid) {
        getStore().updateParticipant(pid, { display: name });
      }
    },
    [sfu, getStore],
  );

  const sendSetState = useCallback(
    (selfMuted: boolean, deafened: boolean): void => {
      sfu.getClient()?.sendSetState(selfMuted, deafened);
    },
    [sfu],
  );

  const sendChat = useCallback(
    (text: string, clientMsgId: string, attachments?: Attachment[]): void => {
      sfu.getClient()?.sendChat({ text, clientMsgId, attachments });
    },
    [sfu],
  );

  const sendChatDelete = useCallback(
    (id: string): boolean => sfu.getClient()?.sendChatDelete(id) ?? false,
    [sfu],
  );

  const handleChatDelete = useCallback((data: ChatDeletedPayload): void => {
    useStore.getState().chatDelete(data.id);
  }, []);

  const handleChatReceive = useCallback((data: ChatPayload): void => {
    const sender = useStore.getState().participants[data.from];
    useStore.getState().chatReceive({
      id: data.id,
      from: data.from,
      text: data.text,
      ts: data.ts,
      clientMsgId: data.clientMsgId,
      pending: false,
      senderName: data.senderName ?? sender?.display,
      senderClientId: sender?.clientId,
      attachments: data.attachments,
    });
  }, []);

  const reconnectSchedulerRef = useRef(
    createReconnectScheduler({
      delays: RECONNECT_DELAYS_MS,
      isLeaving: () => userLeavingRef.current,
      onExhausted: () => {
        getStore().setStatus('Не удалось переподключиться. Перезайдите вручную.', true, true);
      },
      onAttempt: async () => {
        const graph = micGraphRef.current;
        if (!graph) {
          reconnectSchedulerRef.current.reset();
          throw new Error('mic graph gone');
        }
        const cfg = configRef.current;
        if (!cfg) throw new Error('Config not loaded');

        sfu.disconnect();
        audio.cleanupAllRemote();
        useCameraStore.getState().clearRemote();
        getStore().clearParticipants();
        peerIdRef.current = null;
        await connectSfuRef.current(graph, lastDisplayNameRef.current);
      },
    }),
  );

  const connectSfu = useCallback(
    async (graph: MicGraph, display: string): Promise<void> => {
      const cfg = configRef.current;
      if (!cfg) throw new Error('Config not loaded');

      const client = sfu.createClient(
        buildSFUHandlers({
          display,
          audio,
          sfu,
          getStore,
          handleChatReceive,
          handleChatDelete,
          peerIdRef,
          clientIdRef,
          reconnectSchedulerRef,
          userLeavingRef,
        }),
      );

      await client.connect({
        wsUrl: buildWsUrl(roomSlug),
        iceServers: cfg.iceServers,
        localStream: graph.processedLocalStream,
        displayName: display,
        clientId: clientIdRef.current,
      });

      const s = useStore.getState();
      const track = graph.processedLocalStream.getAudioTracks()[0];
      if (track) track.enabled = !s.selfMuted;
      if (s.selfMuted || s.deafened) {
        client.sendSetState(s.selfMuted, s.deafened);
      }
    },
    [audio, sfu, handleChatReceive, handleChatDelete, getStore, roomSlug],
  );

  useEffect(() => {
    connectSfuRef.current = connectSfu;
  }, [connectSfu]);

  const handleLeave = useCallback(() => {
    userLeavingRef.current = true;
    reconnectSchedulerRef.current.reset();
    sfu.disconnect();
    audio.fullCleanup();
    micGraphRef.current = null;
    peerIdRef.current = null;
    useScreenShareStore.getState().clearShares();
    useScreenShareStore.getState().setMyStatus('idle');
    useCameraStore.getState().clearRemote();
    useCameraStore.getState().setSelfStream(null);
    getStore().setCameraOn(false);
    const empty: Record<string, ParticipantUI> = {};
    useStore.setState({ participants: empty });
    getStore().setJoinState('idle');
    getStore().setStatus('Вы вышли из звонка');
  }, [sfu, audio, getStore]);

  const handleJoin = useCallback(
    async (name: string) => {
      if (getStore().joinState === 'joined') return;
      const cfg = configRef.current;
      if (!cfg) {
        getStore().setStatus('Конфигурация не загружена', true);
        return;
      }

      const display = name.trim();
      saveDisplayName(display);

      userLeavingRef.current = false;
      reconnectSchedulerRef.current.reset();
      lastDisplayNameRef.current = display;

      getStore().setJoinState('joining');
      getStore().clearChat();
      getStore().setStatus('Запрашиваю микрофон…');

      const targetEngine = getStore().engine;
      const denoiserReady = isEngineReady(targetEngine);
      const initialEngine: EngineKind = denoiserReady ? targetEngine : 'off';
      if (!denoiserReady) {
        void preloadEngine(targetEngine);
      }

      try {
        const graph = await audio.prepareLocalAudio(initialEngine, (stage) => {
          if (stage === 'mic-ready' && initialEngine !== 'off') {
            getStore().setStatus('Загружаю шумоподавление…');
          }
        });
        micGraphRef.current = graph;

        getStore().setStatus('Подключаюсь…');
        await connectSfu(graph, display);

        getStore().setJoinState('joined');
        getStore().setStatus(
          denoiserReady ? 'Подключено' : 'Подключено. Шумоподавление загружается…',
          false,
          true,
        );

        if (!denoiserReady) {
          const pendingGraph = graph;
          void preloadEngine(targetEngine).then(async () => {
            if (micGraphRef.current !== pendingGraph) return;
            const s = useStore.getState();
            if (s.joinState !== 'joined') return;
            if (s.engine !== targetEngine) return;
            try {
              await switchEngine(targetEngine);
              getStore().setStatus(`Шумоподавление: ${formatEngine(targetEngine)}`, false, true);
            } catch (err) {
              getStore().setStatus(
                `Не удалось включить ${formatEngine(targetEngine)}: ${err instanceof Error ? err.message : String(err)}`,
                true,
                true,
              );
            }
          });
        }

        attachSpeakingLoop(graph);
      } catch (error) {
        handleLeave();
        getStore().setStatus(error instanceof Error ? error.message : String(error), true);
      }
    },
    [audio, connectSfu, handleLeave, switchEngine, attachSpeakingLoop, getStore],
  );

  // ---- Config load on mount ----

  useEffect(() => {
    loadAppConfig()
      .then((cfg) => {
        configRef.current = cfg;
        useStore.getState().setConfigReady(true);
      })
      .catch((err: unknown) => {
        getStore().setStatus(err instanceof Error ? err.message : String(err), true);
      });
    preloadEngine(useStore.getState().engine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Screen share actions ----

  const startScreenShare = useCallback(async (): Promise<void> => {
    const client = sfu.getClient();
    if (!client) throw new Error('Не подключён');
    const share = useScreenShareStore.getState();
    if (share.myStatus !== 'idle') return;
    share.setMyStatus('starting');
    try {
      await client.startScreenShare();
      useScreenShareStore.getState().setMyStatus('publishing');
    } catch (err) {
      const store = useScreenShareStore.getState();
      store.setMyStatus('idle');
      store.setMyStream(null);
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'AbortError') return;
      if (err instanceof Error && err.message === SCREEN_SHARE_NO_CODEC) {
        getStore().setStatus(
          'Браузер не поддерживает кодеки AV1/VP9 для демонстрации экрана.',
          true,
          true,
        );
        return;
      }
      throw err;
    }
  }, [sfu, getStore]);

  const stopScreenShare = useCallback((): void => {
    const client = sfu.getClient();
    if (!client) return;
    useScreenShareStore.getState().setMyStatus('stopping');
    client.stopScreenShare();
  }, [sfu]);

  const updateScreenShareParams = useCallback(async (): Promise<void> => {
    const client = sfu.getClient();
    if (!client || !client.isPublishingScreenShare()) return;
    await client.updateScreenShareParams();
  }, [sfu]);

  const changeScreenShareMode = useCallback(
    async (mode: ShareMode): Promise<void> => {
      const client = sfu.getClient();
      if (!client || !client.isPublishingScreenShare()) return;
      await client.changeScreenShareMode(mode);
    },
    [sfu],
  );

  const subscribeScreenShare = useCallback(
    (publisherId: string): void => {
      sfu.getClient()?.subscribeScreenShare(publisherId);
    },
    [sfu],
  );

  const unsubscribeScreenShare = useCallback(
    (publisherId: string): void => {
      sfu.getClient()?.unsubscribeScreenShare(publisherId);
    },
    [sfu],
  );

  // ---- Camera actions ----

  const openCameraStream = useCallback(async (): Promise<MediaStream> => {
    const deviceId = useStore.getState().camDeviceId;
    const base: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    };
    try {
      const video: MediaTrackConstraints = deviceId
        ? { ...base, deviceId: { exact: deviceId } }
        : base;
      return await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      // A camDeviceId saved on another device won't exist here; the exact
      // constraint then fails without ever prompting. Drop it and retry with
      // the default camera so the permission prompt actually appears.
      // OverconstrainedError is NOT an Error subclass in browsers, so match by name.
      if (deviceId && errorName(err) === 'OverconstrainedError') {
        useStore.getState().setCamDeviceId(null);
        return await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
      }
      throw err;
    }
  }, []);

  const startCamera = useCallback(async (): Promise<void> => {
    const client = sfu.getClient();
    if (!client) throw new Error('Не подключён');
    if (client.isPublishingCamera()) return;
    getStore().setStatus('Включаю камеру…');
    try {
      const stream = await openCameraStream();
      await client.startCamera(stream);
      getStore().setCameraOn(true);
      const pid = peerIdRef.current;
      if (pid) getStore().updateParticipant(pid, { cameraOn: true });
      getStore().setStatus('Камера включена', false, true);
    } catch (err) {
      useCameraStore.getState().setSelfStream(null);
      getStore().setCameraOn(false);
      const name = errorName(err);
      if (!navigator.mediaDevices?.getUserMedia || name === 'NotSupportedError' || name === 'TypeError') {
        getStore().setStatus(
          'Камера недоступна в этом браузере. Откройте сайт в Safari или Chrome, а не во встроенном браузере мессенджера.',
          true,
          true,
        );
        return;
      }
      if (name === 'NotAllowedError' || name === 'AbortError') {
        getStore().setStatus(
          IS_ANDROID
            ? 'Доступ к камере не разрешён. На Android: разрешите камеру браузеру ' +
                '(Настройки → Приложения → ваш браузер → Разрешения) и проверьте «Доступ к камере» в шторке.'
            : 'Доступ к камере не разрешён. Разрешите камеру для сайта в настройках браузера.',
          true,
          true,
        );
        return;
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        getStore().setStatus('Камера не найдена.', true, true);
        return;
      }
      getStore().setStatus(
        `Не удалось включить камеру: ${err instanceof Error ? err.message : String(err)}`,
        true,
        true,
      );
    }
  }, [sfu, openCameraStream, getStore]);

  const stopCamera = useCallback((): void => {
    const client = sfu.getClient();
    client?.stopCamera();
    getStore().setCameraOn(false);
    const pid = peerIdRef.current;
    if (pid) getStore().updateParticipant(pid, { cameraOn: false });
    getStore().setStatus('Камера выключена', false, true);
  }, [sfu, getStore]);

  // Live camera device swap: re-capture with the newly selected device and
  // replace the published track in place. No-op when the camera is off — the
  // new device is picked up the next time the camera is turned on.
  const switchCamDevice = useCallback(async (): Promise<void> => {
    const client = sfu.getClient();
    if (!client || !client.isPublishingCamera()) return;
    const stream = await openCameraStream();
    await client.replaceCameraTrack(stream);
  }, [sfu, openCameraStream]);

  return {
    join: handleJoin,
    leave: handleLeave,
    getPeerId,
    setMicEnabled,
    switchEngine,
    switchMicDevice,
    setRemoteDisplayName,
    sendSetState,
    sendChat,
    sendChatDelete,
    startScreenShare,
    stopScreenShare,
    updateScreenShareParams,
    changeScreenShareMode,
    subscribeScreenShare,
    unsubscribeScreenShare,
    startCamera,
    stopCamera,
    switchCamDevice,
    handleChatReceive,
    handleChatDelete,
  };
}
