import Picker, { EmojiStyle, Theme } from 'emoji-picker-react';

/** Loaded only when the composer picker is opened; the full catalog stays off the typing path. */
export function EmojiPicker({ onChoose }: { onChoose: (emoji: string) => void }) {
  return <div className="emoji-picker" aria-label="Emoji picker">
    <Picker
      onEmojiClick={({ emoji }) => onChoose(emoji)}
      emojiStyle={EmojiStyle.NATIVE}
      theme={Theme.DARK}
      width="100%"
      height={330}
      lazyLoadEmojis={false}
      autoFocusSearch
      searchPlaceHolder="Search emoji…"
      previewConfig={{ showPreview: false }}
    />
  </div>;
}
