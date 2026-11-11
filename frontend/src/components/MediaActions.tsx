import { Download } from 'lucide-react';
import type { Attachment } from '../sfu/protocol';
import { useDownload } from '../hooks/useAttachmentUrl';

type Props = {
  attachment: Attachment;
  roomId: string;
};

// Download button in the top-right corner of a photo or video tile. The tile
// must be `group relative`: it shows on hover or keyboard focus, and always
// without hover (touch screens).
export function MediaActions({ attachment, roomId }: Props) {
  const { state, start } = useDownload([attachment], roomId);

  return (
    <div className="absolute right-1 top-1 hidden gap-1 group-hover:flex group-has-[:focus-visible]:flex [@media(hover:none)]:flex">
      <button
        type="button"
        aria-label="Скачать"
        title={state === 'failed' ? 'Не удалось скачать · повторить' : 'Скачать'}
        disabled={state === 'busy'}
        onClick={start}
        className={`grid place-items-center bg-black/60 p-1 transition-colors hover:bg-black/80 disabled:opacity-60 ${state === 'failed' ? 'text-danger' : 'text-white'}`}
      >
        <Download size={16} />
      </button>
    </div>
  );
}
