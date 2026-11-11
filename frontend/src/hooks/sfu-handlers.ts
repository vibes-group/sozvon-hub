import type { MutableRefObject } from 'react';
import { useStore } from '../store/useStore';
import { useScreenShareStore, type ScreenShare } from '../store/useScreenShareStore';
import { useCameraStore } from '../store/useCameraStore';
import type { useAudioEngine } from './useAudioEngine';
import type { useSFU } from './useSFU';
import { loadPeerVolume } from '../utils/storage';
import type { ChatPayload, ChatDeletedPayload, PeerInfo } from '../sfu/protocol';
import type { SFUHandlers } from '../sfu/client';
import { screenShareErrorRu } from '../screenshare/errors';
import type { ReconnectScheduler } from '../utils/reconnect';
import type { ParticipantUI } from '../types';

// Roster entry for a remote peer from welcome / peer-joined, restoring our
// saved volume for them by clientId.
function upsertRemotePeer(p: PeerInfo): void {
  const stored = p.clientId ? loadPeerVolume(p.clientId) : null;
  useStore.getState().upsertParticipant({
    id: p.id,
    display: p.displayName ?? `peer-${p.id}`,
    clientId: p.clientId,
    remoteMuted: p.selfMuted ?? false,
    remoteDeafened: p.deafened ?? false,
    screenSharing: p.screenSharing ?? false,
    cameraOn: p.cameraOn ?? false,
    ...(stored !== null ? { localVolume: stored } : {}),
  });
}

function shareOf(p: PeerInfo): ScreenShare {
  return {
    publisherId: p.id,
    hasSystemAudio: p.screenSharingHasAudio ?? false,
    videoCodec: p.screenSharingVideoCodec,
  };
}

type SFUHandlerDeps = {
  display: string;
  audio: ReturnType<typeof useAudioEngine>;
  sfu: ReturnType<typeof useSFU>;
  handleChatReceive: (data: ChatPayload) => void;
  handleChatDelete: (data: ChatDeletedPayload) => void;
  peerIdRef: MutableRefObject<string | null>;
  clientIdRef: MutableRefObject<string>;
  reconnectSchedulerRef: MutableRefObject<ReconnectScheduler>;
  userLeavingRef: MutableRefObject<boolean>;
};

export function buildSFUHandlers(deps: SFUHandlerDeps): Partial<SFUHandlers> {
  const {
    display,
    audio,
    sfu,
    handleChatReceive,
    handleChatDelete,
    peerIdRef,
    clientIdRef,
    reconnectSchedulerRef,
    userLeavingRef,
  } = deps;
  const getStore = useStore.getState;

  function subscribeCamera(publisherId: string): void {
    if (publisherId === peerIdRef.current) return;
    sfu.getClient()?.subscribeCamera(publisherId);
  }

  function addPeer(p: PeerInfo): void {
    upsertRemotePeer(p);
    if (p.screenSharing) useScreenShareStore.getState().upsertShare(shareOf(p));
    if (p.cameraOn) subscribeCamera(p.id);
  }

  return {
    onState: (s) => {
      if (s === 'connected') {
        reconnectSchedulerRef.current.reset();
        getStore().setStatus('Подключено', false, true);
      } else if (s === 'failed' || s === 'closed') {
        if (getStore().joinState === 'joined' && !userLeavingRef.current) {
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
      useScreenShareStore.getState().clearShares();
      useCameraStore.getState().clearRemote();
      for (const p of peers ?? []) addPeer(p);
    },
    onPeerJoined: addPeer,
    onPeerLeft: ({ id }) => {
      audio.detachRemoteStream(id);
      getStore().removeParticipant(id);
      useScreenShareStore.getState().removeShare(id);
      useCameraStore.getState().removeRemote(id);
    },
    onPeerInfo: (p) => {
      const patch: Partial<ParticipantUI> = {
        screenSharing: Boolean(p.screenSharing),
        cameraOn: Boolean(p.cameraOn),
      };
      if (p.displayName) patch.display = p.displayName;
      if (p.clientId) patch.clientId = p.clientId;
      getStore().updateParticipant(p.id, patch);
      const share = useScreenShareStore.getState();
      if (p.screenSharing) share.upsertShare(shareOf(p));
      else share.removeShare(p.id);
    },
    onPeerState: ({ id, selfMuted, deafened }) => {
      getStore().updateParticipant(id, { remoteMuted: selfMuted, remoteDeafened: deafened });
    },
    onChat: handleChatReceive,
    onChatDeleted: handleChatDelete,
    onTrack: ({ track, stream, peerId }) => {
      if (track.kind === 'audio') {
        getStore().upsertParticipant({ id: peerId, hasStream: true });
        audio.attachRemoteStream(peerId, stream);
      }
    },
    onTrackRemoved: ({ peerId }) => {
      audio.detachRemoteStream(peerId);
      if (getStore().participants[peerId])
        getStore().updateParticipant(peerId, { hasStream: false });
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
