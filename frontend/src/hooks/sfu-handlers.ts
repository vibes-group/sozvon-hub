import type { MutableRefObject } from 'react';
import { useStore } from '../store/useStore';
import { useScreenShareStore } from '../store/useScreenShareStore';
import { useCameraStore } from '../store/useCameraStore';
import type { useAudioEngine } from './useAudioEngine';
import type { useSFU } from './useSFU';
import { loadPeerVolume } from '../utils/storage';
import type { ChatPayload, ChatDeletedPayload } from '../sfu/protocol';
import type { SFUHandlers } from '../sfu/client';
import { screenShareErrorRu } from '../screenshare/errors';
import { createReconnectScheduler } from '../utils/reconnect';

type SFUHandlerDeps = {
  display: string;
  audio: ReturnType<typeof useAudioEngine>;
  sfu: ReturnType<typeof useSFU>;
  getStore: typeof useStore.getState;
  handleChatReceive: (data: ChatPayload) => void;
  handleChatDelete: (data: ChatDeletedPayload) => void;
  peerIdRef: MutableRefObject<string | null>;
  clientIdRef: MutableRefObject<string>;
  reconnectSchedulerRef: MutableRefObject<ReturnType<typeof createReconnectScheduler>>;
  userLeavingRef: MutableRefObject<boolean>;
};

export function buildSFUHandlers(deps: SFUHandlerDeps): Partial<SFUHandlers> {
  const {
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
  } = deps;

  function subscribeCamera(publisherId: string): void {
    if (publisherId === peerIdRef.current) return;
    sfu.getClient()?.subscribeCamera(publisherId);
  }

  return {
    onState: (s) => {
      if (s === 'connected') {
        reconnectSchedulerRef.current.reset();
        getStore().setStatus('Подключено', false, true);
      } else if (s === 'failed' || s === 'closed') {
        if (useStore.getState().joinState === 'joined' && !userLeavingRef.current) {
          const nextAttempt = reconnectSchedulerRef.current.attemptIndex + 1;
          getStore().setStatus(
            `Соединение оборвалось, переподключаюсь (попытка ${nextAttempt})…`,
            true,
            true,
          );
          reconnectSchedulerRef.current.schedule();
        }
      }
    },
    onWelcome: ({ id, peers }) => {
      peerIdRef.current = id;
      getStore().clearParticipants();
      getStore().upsertParticipant({
        id,
        display,
        isSelf: true,
        clientId: clientIdRef.current,
      });
      const share = useScreenShareStore.getState();
      share.clearShares();
      useCameraStore.getState().clearRemote();
      for (const p of peers ?? []) {
        const stored = p.clientId ? loadPeerVolume(p.clientId) : null;
        getStore().upsertParticipant({
          id: p.id,
          display: p.displayName ?? `peer-${p.id}`,
          clientId: p.clientId,
          remoteMuted: p.selfMuted ?? false,
          remoteDeafened: p.deafened ?? false,
          screenSharing: p.screenSharing ?? false,
          cameraOn: p.cameraOn ?? false,
          ...(stored !== null ? { localVolume: stored } : {}),
        });
        if (p.screenSharing) {
          share.upsertShare({
            publisherId: p.id,
            hasSystemAudio: p.screenSharingHasAudio ?? false,
            videoCodec: p.screenSharingVideoCodec,
          });
        }
        if (p.cameraOn) subscribeCamera(p.id);
      }
    },
    onPeerJoined: ({
      id,
      displayName: peerDisplay,
      clientId,
      selfMuted,
      deafened,
      screenSharing,
      screenSharingHasAudio,
      screenSharingVideoCodec,
      cameraOn,
    }) => {
      const stored = clientId ? loadPeerVolume(clientId) : null;
      getStore().upsertParticipant({
        id,
        display: peerDisplay ?? `peer-${id}`,
        clientId,
        remoteMuted: selfMuted ?? false,
        remoteDeafened: deafened ?? false,
        screenSharing: screenSharing ?? false,
        cameraOn: cameraOn ?? false,
        ...(stored !== null ? { localVolume: stored } : {}),
      });
      if (screenSharing) {
        useScreenShareStore.getState().upsertShare({
          publisherId: id,
          hasSystemAudio: screenSharingHasAudio ?? false,
          videoCodec: screenSharingVideoCodec,
        });
      }
      if (cameraOn) subscribeCamera(id);
    },
    onPeerLeft: ({ id }) => {
      audio.detachRemoteStream(id);
      getStore().removeParticipant(id);
      useScreenShareStore.getState().removeShare(id);
      useCameraStore.getState().removeRemote(id);
    },
    onPeerInfo: ({
      id,
      displayName: peerDisplay,
      clientId,
      screenSharing,
      screenSharingHasAudio,
      screenSharingVideoCodec,
      cameraOn,
    }) => {
      const patch: {
        display?: string;
        clientId?: string;
        screenSharing?: boolean;
        cameraOn?: boolean;
      } = { screenSharing: Boolean(screenSharing), cameraOn: Boolean(cameraOn) };
      if (peerDisplay) patch.display = peerDisplay;
      if (clientId) patch.clientId = clientId;
      getStore().updateParticipant(id, patch);
      const share = useScreenShareStore.getState();
      if (screenSharing) {
        share.upsertShare({
          publisherId: id,
          hasSystemAudio: screenSharingHasAudio ?? false,
          videoCodec: screenSharingVideoCodec,
        });
      } else {
        share.removeShare(id);
      }
    },
    onPeerState: ({ id, selfMuted, deafened }) => {
      getStore().updateParticipant(id, { remoteMuted: selfMuted, remoteDeafened: deafened });
    },
    onChat: handleChatReceive,
    onChatDeleted: handleChatDelete,
    onTrack: ({ track, stream, peerId }) => {
      if (!peerId) return;
      if (track.kind === 'audio') {
        getStore().upsertParticipant({ id: peerId, hasStream: true });
        audio.attachRemoteStream(peerId, stream);
      }
    },
    onScreenShareAvailable: ({ publisherId, hasSystemAudio, videoCodec }) => {
      useScreenShareStore.getState().upsertShare({ publisherId, hasSystemAudio, videoCodec });
    },
    onScreenShareEnded: ({ publisherId }) => {
      const store = useScreenShareStore.getState();
      store.removeShare(publisherId);
      if (publisherId === peerIdRef.current && store.myStatus === 'publishing') {
        store.setMyStatus('idle');
        getStore().setStatus('Демонстрация прервана разрывом соединения.', true, true);
      }
    },
    onScreenShareError: ({ publisherId, reason }) => {
      const store = useScreenShareStore.getState();
      if (publisherId) store.removeShare(publisherId);
      if (!publisherId || reason === 'already-publishing' || reason === 'internal') {
        store.setMyStatus('idle');
      }
      const msg = screenShareErrorRu(reason);
      if (msg) getStore().setStatus(msg, true, true);
    },
    onScreenShareTrack: ({ publisherId, stream, kind }) => {
      const store = useScreenShareStore.getState();
      if (kind === 'video') store.attachFocusedVideo(publisherId, stream);
      else store.attachFocusedAudio(publisherId, stream);
    },
    onScreenShareSelfStarted: ({ stream, videoCodec }) => {
      useScreenShareStore.getState().setMyStream(stream, videoCodec);
    },
    onScreenShareSelfStopped: () => {
      const store = useScreenShareStore.getState();
      store.setMyStatus('idle');
      store.setMyStream(null);
    },
    onScreenShareSystemAudioWarning: ({ reason }) => {
      if (reason === 'monitor-feedback-risk') {
        getStore().setStatus(
          'Зрители могут слышать свои голоса. Демонстрируйте окно, а не весь монитор.',
          true,
          true,
        );
      }
    },
    onCameraAvailable: ({ publisherId }) => {
      getStore().updateParticipant(publisherId, { cameraOn: true });
      subscribeCamera(publisherId);
    },
    onCameraEnded: ({ publisherId }) => {
      getStore().updateParticipant(publisherId, { cameraOn: false });
      useCameraStore.getState().removeRemote(publisherId);
    },
    onCameraTrack: ({ publisherId, stream }) => {
      useCameraStore.getState().attachRemote(publisherId, stream);
    },
    onCameraSelfStarted: ({ stream }) => {
      useCameraStore.getState().setSelfStream(stream);
    },
    onCameraSelfStopped: () => {
      useCameraStore.getState().setSelfStream(null);
    },
    onError: (err) => {
      console.warn('[sfu]', err);
    },
  };
}
