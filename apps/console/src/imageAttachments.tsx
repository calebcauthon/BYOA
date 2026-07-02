/**
 * Prompt image attachments — paste or pick images to send along with a prompt.
 *
 * Images are held as data URLs (`data:<mime>;base64,<…>`) so they travel in the
 * ordinary JSON launch/continue request; the orchestrator hands them to the runner,
 * which materializes them as files the agent can read. The UI here is deliberately
 * self-contained so both the new-run prompt box and the conversation composer can
 * reuse it.
 */
import { useCallback, useRef, useState, type ClipboardEvent } from "react";
import { ImagePlus, X } from "lucide-react";

export interface AttachedImage {
  id: string;
  name: string;
  /** data URL: data:<mime>;base64,<…> */
  dataUrl: string;
}

const MAX_IMAGES = 6;
/** Per-image ceiling before base64 inflation, to keep request bodies sane. */
const MAX_BYTES = 8 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export interface ImageAttachments {
  images: AttachedImage[];
  error: string | null;
  atCapacity: boolean;
  addFiles: (files: Iterable<File>) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
}

export function useImageAttachments(): ImageAttachments {
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const addFiles = useCallback(async (files: Iterable<File>) => {
    const pics = [...files].filter((f) => f.type.startsWith("image/"));
    if (pics.length === 0) return;
    const accepted: AttachedImage[] = [];
    let rejected: string | null = null;
    for (const file of pics) {
      if (file.size > MAX_BYTES) {
        rejected = `${file.name || "image"} is too large (max ${Math.round(MAX_BYTES / (1024 * 1024))}MB)`;
        continue;
      }
      try {
        const dataUrl = await readAsDataUrl(file);
        accepted.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || "pasted image",
          dataUrl,
        });
      } catch {
        rejected = "could not read an image";
      }
    }
    setImages((cur) => {
      const room = MAX_IMAGES - cur.length;
      if (accepted.length > room) rejected = `at most ${MAX_IMAGES} images per prompt`;
      return [...cur, ...accepted.slice(0, Math.max(0, room))];
    });
    setError(accepted.length ? (rejected ?? null) : rejected);
  }, []);

  const remove = useCallback((id: string) => {
    setImages((cur) => cur.filter((img) => img.id !== id));
  }, []);

  const clear = useCallback(() => {
    setImages([]);
    setError(null);
  }, []);

  return { images, error, atCapacity: images.length >= MAX_IMAGES, addFiles, remove, clear };
}

/** Extract image files from a paste event. Returns true if any were handled, so
 *  the caller can suppress the default paste (which would otherwise insert a file
 *  name or nothing into the textarea). */
export function pasteHasImages(event: ClipboardEvent): File[] {
  const files: File[] = [];
  for (const item of event.clipboardData.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

/** Thumbnail strip + "add images" file picker. Renders nothing but the picker
 *  button when no images are attached. */
export function ImageStrip({
  attachments,
  disabled,
}: {
  attachments: ImageAttachments;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { images, error, atCapacity, addFiles, remove } = attachments;

  return (
    <div className="image-attach">
      <button
        type="button"
        className="image-attach-add"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || atCapacity}
        title={atCapacity ? "Attachment limit reached" : "Attach images (or paste into the prompt)"}
      >
        <ImagePlus size={14} /> {images.length ? "Add more" : "Add images"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files);
          e.target.value = ""; // allow re-picking the same file
        }}
      />
      {error ? <span className="image-attach-error">{error}</span> : images.length ? (
        <span className="image-attach-hint">{images.length} attached</span>
      ) : (
        <span className="image-attach-hint">Paste or attach screenshots for the agent to see</span>
      )}
      {images.length > 0 && (
        <ul className="image-attach-thumbs">
          {images.map((img) => (
            <li key={img.id} className="image-attach-thumb">
              <img src={img.dataUrl} alt={img.name} />
              <button type="button" aria-label={`Remove ${img.name}`} onClick={() => remove(img.id)}>
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
