import { useState } from 'react';
import { Check, Copy, Share2 } from 'lucide-react';
import { copyToClipboard, shareUrl } from '../api';

// "Скопировать" + "Поделиться" pair shown next to a link. Each instance owns its
// own 2 s confirmation tick, so buttons never interfere. On desktop "поделиться"
// copies; on mobile it opens the native share sheet (which gives its own
// feedback, but the tick is harmless either way).
export function ShareButtons({ url, title }: { url: string; title: string }) {
  const [done, setDone] = useState<'copy' | 'share' | null>(null);

  const flash = (action: 'copy' | 'share') => {
    setDone(action);
    setTimeout(() => setDone(null), 2000);
  };

  const copy = async () => {
    if (await copyToClipboard(url)) flash('copy');
  };
  const share = async () => {
    if ((await shareUrl(url, title)) !== 'fail') flash('share');
  };

  return (
    <>
      <button
        className="btn btn-secondary btn-mini shrink-0"
        onClick={copy}
        title="Скопировать ссылку"
        aria-label="Скопировать ссылку"
      >
        {done === 'copy' ? <Check size={15} /> : <Copy size={15} />}
      </button>
      <button
        className="btn btn-secondary btn-mini shrink-0"
        onClick={share}
        title="Поделиться ссылкой"
        aria-label="Поделиться ссылкой"
      >
        {done === 'share' ? <Check size={15} /> : <Share2 size={15} />}
      </button>
    </>
  );
}
