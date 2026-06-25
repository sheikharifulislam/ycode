'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { AGENT_MODELS, DEFAULT_AGENT_MODEL } from '@/lib/agent/models';
import { cn } from '@/lib/utils';
import type { ImageAttachment, Mention } from '@/stores/useAiChatStore';
import { useEditorStore } from '@/stores/useEditorStore';

import { LayerMentionWithView } from './LayerMentionView';

const MAX_IMAGES = 4;
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_MENTION_RESULTS = 8;

const MENTION_ICON: Record<Mention['type'], 'page' | 'database' | 'layers'> = {
  page: 'page',
  collection: 'database',
  layer: 'layers',
};

/** The active "@query" token under the caret, if any. */
function getActiveMention(text: string, caret: number): { query: string; start: number } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;
  const charBefore = at === 0 ? ' ' : upto[at - 1];
  if (!/\s/.test(charBefore)) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, start: at };
}

/** Read an image File into a base64 attachment, or null if it's unsupported. */
function fileToImageAttachment(file: File): Promise<ImageAttachment | null> {
  return new Promise((resolve) => {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      if (comma === -1) {
        resolve(null);
        return;
      }
      resolve({ mediaType: file.type, data: dataUrl.slice(comma + 1), dataUrl });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** Serialize the editor doc into plain text (pills become "@label") plus the
 * deduped list of mentions the user referenced via pills. */
function editorToMessage(editor: Editor): { text: string; mentions: Mention[] } {
  const { doc } = editor.state;
  const text = doc.textBetween(0, doc.content.size, '\n', (leaf) =>
    leaf.type.name === 'layerMention' ? `@${leaf.attrs.label}` : '',
  );
  const seen = new Set<string>();
  const mentions: Mention[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'layerMention') {
      const key = `${node.attrs.mentionType}:${node.attrs.mentionId}`;
      if (!seen.has(key)) {
        seen.add(key);
        mentions.push({
          type: node.attrs.mentionType,
          id: node.attrs.mentionId,
          label: node.attrs.label,
        });
      }
    }
  });
  return { text: text.trim(), mentions };
}

interface ChatComposerProps {
  model: string | null;
  onModelChange: (model: string | null) => void;
  isStreaming: boolean;
  onStop: () => void;
  /** Submit the composed message. Images and pill mentions come from the editor. */
  onSubmit: (text: string, mentions: Mention[], images: ImageAttachment[]) => void;
  /** All @-mention candidates (pages, collections, layers). */
  mentionCandidates: Mention[];
  /** Layer-only candidates for the cursor-button picker. */
  layerMentions: Mention[];
}

export default function ChatComposer({
  model,
  onModelChange,
  isStreaming,
  onStop,
  onSubmit,
  mentionCandidates,
  layerMentions,
}: ChatComposerProps) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [isPicking, setIsPicking] = useState(false);

  const selectedLayerIds = useEditorStore((s) => s.selectedLayerIds);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  // The selection present when pick mode was armed; we wait for the *next* canvas
  // / sidebar selection before turning it into a pill.
  const pickBaselineRef = useRef<string[]>([]);
  const layerMentionsRef = useRef(layerMentions);
  layerMentionsRef.current = layerMentions;

  const mentionResults = useMemo<Mention[]>(() => {
    if (!mentionActive) return [];
    const query = mentionQuery.toLowerCase();
    return mentionCandidates
      .filter((candidate) => candidate.label.toLowerCase().includes(query))
      .slice(0, MAX_MENTION_RESULTS);
  }, [mentionActive, mentionQuery, mentionCandidates]);

  // Mirror dynamic state into refs so the editor's keydown/paste handlers (bound
  // once at init) always read current values without re-creating the editor.
  const mentionActiveRef = useRef(mentionActive);
  mentionActiveRef.current = mentionActive;
  const mentionResultsRef = useRef(mentionResults);
  mentionResultsRef.current = mentionResults;
  const mentionIndexRef = useRef(mentionIndex);
  mentionIndexRef.current = mentionIndex;

  const closeMention = useCallback(() => {
    setMentionActive(false);
    setMentionQuery('');
    setMentionIndex(0);
  }, []);

  const addImageFiles = useCallback(async (files: FileList | File[]) => {
    const slots = MAX_IMAGES - imagesRef.current.length;
    if (slots <= 0) return;
    const converted = (
      await Promise.all(Array.from(files).slice(0, slots).map(fileToImageAttachment))
    ).filter((img): img is ImageAttachment => img !== null);
    if (converted.length > 0) {
      setImages((prev) => [...prev, ...converted].slice(0, MAX_IMAGES));
    }
  }, []);

  const insertMentionPill = useCallback((candidate: Mention) => {
    const editor = editorRef.current;
    if (!editor) return;
    const { state } = editor;
    const { from } = state.selection;
    const startPos = state.selection.$from.start();
    const textBefore = state.doc.textBetween(startPos, from, undefined, '\uFFFC');
    const active = getActiveMention(textBefore, textBefore.length);
    // "@" + query are size-1 chars immediately before the caret, so we can delete
    // them by offset without mapping serialized indices back to doc positions.
    const deleteFrom = active ? from - (active.query.length + 1) : from;
    editor
      .chain()
      .focus()
      .deleteRange({ from: deleteFrom, to: from })
      .insertLayerMention({
        mentionId: candidate.id,
        mentionType: candidate.type,
        label: candidate.label,
      })
      .run();
    closeMention();
  }, [closeMention]);

  /** Insert pills for the given layer ids, resolving their labels from the tree. */
  const insertLayerPills = useCallback((ids: string[]) => {
    const editor = editorRef.current;
    if (!editor || ids.length === 0) return;
    let chain = editor.chain().focus();
    for (const id of ids) {
      const match = layerMentionsRef.current.find((candidate) => candidate.id === id);
      chain = chain.insertLayerMention({
        mentionId: id,
        mentionType: 'layer',
        label: match?.label ?? 'Layer',
      });
    }
    chain.run();
  }, []);

  const submit = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || isStreaming) return;
    const { text, mentions } = editorToMessage(editor);
    if (!text.trim() && imagesRef.current.length === 0) return;
    onSubmit(text, mentions, imagesRef.current);
    editor.commands.clearContent();
    setImages([]);
    closeMention();
  }, [isStreaming, onSubmit, closeMention]);

  // Stable refs for the editor's one-time keydown handler.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const insertMentionPillRef = useRef(insertMentionPill);
  insertMentionPillRef.current = insertMentionPill;
  const closeMentionRef = useRef(closeMention);
  closeMentionRef.current = closeMention;
  const addImageFilesRef = useRef(addImageFiles);
  addImageFilesRef.current = addImageFiles;

  const moveMention = useCallback((delta: number) => {
    const len = mentionResultsRef.current.length;
    if (len === 0) return;
    setMentionIndex((index) => (index + delta + len) % len);
  }, []);
  const moveMentionRef = useRef(moveMention);
  moveMentionRef.current = moveMention;

  const computeMention = useCallback((editor: Editor) => {
    const { state } = editor;
    const { from, empty } = state.selection;
    if (!empty) {
      setMentionActive(false);
      return;
    }
    const startPos = state.selection.$from.start();
    const textBefore = state.doc.textBetween(startPos, from, undefined, '\uFFFC');
    const active = getActiveMention(textBefore, textBefore.length);
    if (!active) {
      setMentionActive(false);
      return;
    }
    setMentionQuery(active.query);
    setMentionActive(true);
    setMentionIndex(0);
  }, []);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: false }),
      Placeholder.configure({
        placeholder: 'Ask AI to build, edit, or @mention a page, collection, or layer...',
      }),
      LayerMentionWithView,
    ],
    editorProps: {
      attributes: {
        class:
          'ai-chat-composer max-h-48 min-h-[84px] overflow-y-auto px-3 pt-2.5 pb-1 text-xs leading-relaxed focus:outline-none',
      },
      handleKeyDown: (_view, event) => {
        if (mentionActiveRef.current && mentionResultsRef.current.length > 0) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveMentionRef.current(1);
            return true;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveMentionRef.current(-1);
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            const results = mentionResultsRef.current;
            const idx = Math.min(mentionIndexRef.current, results.length - 1);
            insertMentionPillRef.current(results[idx]);
            return true;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            closeMentionRef.current();
            return true;
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submitRef.current();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const imageFiles = Array.from(event.clipboardData?.files ?? []).filter((file) =>
          file.type.startsWith('image/'),
        );
        if (imageFiles.length > 0) {
          event.preventDefault();
          void addImageFilesRef.current(imageFiles);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: instance }) => computeMention(instance),
    onSelectionUpdate: ({ editor: instance }) => computeMention(instance),
  });

  editorRef.current = editor;

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addImageFiles(event.target.files);
    event.target.value = '';
  };

  // Arm/disarm pick mode. Snapshot the current selection so we only react to the
  // user's *next* pick, not whatever happened to be selected when they clicked.
  const togglePicking = useCallback(() => {
    setIsPicking((prev) => {
      const next = !prev;
      if (next) pickBaselineRef.current = useEditorStore.getState().selectedLayerIds;
      return next;
    });
  }, []);

  // While armed, the next non-empty canvas / sidebar selection becomes pill(s).
  useEffect(() => {
    if (!isPicking) return;
    const baseline = pickBaselineRef.current;
    const unchanged =
      baseline.length === selectedLayerIds.length &&
      baseline.every((id, index) => id === selectedLayerIds[index]);
    if (unchanged || selectedLayerIds.length === 0) return;
    const ids = selectedLayerIds;
    // Defer to a microtask: inserting a pill dispatches a TipTap transaction that
    // mounts a React NodeView via flushSync, which throws if run while React is
    // still rendering (this effect can fire synchronously from a store update).
    queueMicrotask(() => insertLayerPills(ids));
    setIsPicking(false);
  }, [isPicking, selectedLayerIds, insertLayerPills]);

  // Escape cancels pick mode (the user is clicking around the canvas, not the editor).
  useEffect(() => {
    if (!isPicking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsPicking(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isPicking]);

  // Mirror pick mode into the editor store so the canvas can show teal outlines
  // and a crosshair cursor while the user is choosing a layer to reference.
  useEffect(() => {
    useEditorStore.getState().setAiLayerPicking(isPicking);
    return () => useEditorStore.getState().setAiLayerPicking(false);
  }, [isPicking]);

  return (
    <div className="relative">
      {mentionActive && mentionResults.length > 0 && (
        <MentionMenu
          results={mentionResults}
          activeIndex={Math.min(mentionIndex, mentionResults.length - 1)}
          onPick={insertMentionPill}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        multiple
        className="hidden"
        onChange={handleFileChange}
      />
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {images.map((image, index) => (
            <div key={image.dataUrl} className="relative size-12 rounded-md overflow-hidden border group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.dataUrl} alt="Attachment"
                className="size-full object-cover"
              />
              <button
                type="button"
                onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                className="absolute top-0 right-0 bg-background/80 rounded-bl p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label="Remove image"
              >
                <Icon name="x" className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-col rounded-lg border border-transparent bg-input transition-colors focus-within:border-ring">
        <EditorContent editor={editor} />
        <div className="flex items-center justify-between gap-1 px-2 pb-2">
          <ModelPicker model={model} onChange={onModelChange} />
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant={isPicking ? 'teal' : 'ghost'}
              onClick={togglePicking}
              aria-label="Reference a layer"
              aria-pressed={isPicking}
              title={isPicking ? 'Select a layer in the canvas or layers panel' : 'Reference a layer'}
            >
              <Icon name="cursor-default" />
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={images.length >= MAX_IMAGES}
              aria-label="Attach image"
              title={images.length >= MAX_IMAGES ? `Up to ${MAX_IMAGES} images` : 'Attach image'}
            >
              <Icon name="image" />
            </Button>
            {isStreaming ? (
              <Button
                size="xs"
                variant="secondary"
                onClick={onStop}
                aria-label="Stop"
              >
                <Icon name="stop" />
              </Button>
            ) : (
              <Button
                size="xs"
                variant="secondary"
                onClick={submit}
                aria-label="Send"
              >
                <Icon name="arrowLeft" className="rotate-90" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelPicker({
  model,
  onChange,
}: {
  model: string | null;
  onChange: (model: string | null) => void;
}) {
  const current = AGENT_MODELS.find((option) => option.id === model);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
        >
          {current?.label ?? 'Select model'}
          <Icon name="chevronDown" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={model ?? DEFAULT_AGENT_MODEL}
          onValueChange={(value) => onChange(value)}
        >
          {AGENT_MODELS.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MentionMenu({
  results,
  activeIndex,
  onPick,
}: {
  results: Mention[];
  activeIndex: number;
  onPick: (mention: Mention) => void;
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 max-h-56 overflow-y-auto rounded-lg border bg-popover shadow-md py-1 z-50">
      {results.map((result, index) => (
        <button
          key={`${result.type}-${result.id}`}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(result)}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
            index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
          )}
        >
          <Icon name={MENTION_ICON[result.type]} className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{result.label}</span>
          <span className="ml-auto shrink-0 text-[10px] capitalize text-muted-foreground">{result.type}</span>
        </button>
      ))}
    </div>
  );
}
