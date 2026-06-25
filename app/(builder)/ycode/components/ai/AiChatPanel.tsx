'use client';

import { useEffect, useMemo, useRef } from 'react';

import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { getLayerName } from '@/lib/layer-display-utils';
import { findLayerById } from '@/lib/layer-utils';
import { cn } from '@/lib/utils';
import { useAiChatStore } from '@/stores/useAiChatStore';
import type { ChatMessage, ChatMessagePart, ChatSession, ChatToolCall, ImageAttachment, Mention, SelectedLayerRef, SessionUsage } from '@/stores/useAiChatStore';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';
import type { Layer } from '@/types';

import { toolCallLabel } from './ai-tool-labels';
import ChatComposer from './ChatComposer';

const SUGGESTIONS = [
  'Add a hero section with a headline and a call to action',
  'Create a 3-column features section',
  'Add a contact form at the bottom of this page',
];

const URL_REGEX = /\bhttps?:\/\/[^\s]+/gi;

function parseUrls(text: string): string[] {
  return Array.from(new Set(text.match(URL_REGEX) ?? [])).map((url) => url.replace(/[.,)]+$/, ''));
}

let markdownLinkHookRegistered = false;

/** Render assistant markdown to sanitized HTML (links open in a new tab). */
function renderMarkdown(text: string): string {
  if (!markdownLinkHookRegistered) {
    markdownLinkHookRegistered = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
  const html = marked.parse(text, { gfm: true, breaks: true, async: false }) as string;
  return DOMPurify.sanitize(html);
}

/** Flatten a layer tree into mention candidates (skips the root Body layer). */
function flattenLayerMentions(layers: Layer[], acc: Mention[] = []): Mention[] {
  for (const layer of layers) {
    if (layer.id !== 'body') {
      acc.push({ type: 'layer', id: layer.id, label: getLayerName(layer) });
    }
    if (layer.children?.length) flattenLayerMentions(layer.children, acc);
  }
  return acc;
}

interface AiChatPanelProps {
  embedded?: boolean;
}

export default function AiChatPanel({ embedded = false }: AiChatPanelProps) {
  const messages = useAiChatStore((s) => s.messages);
  const status = useAiChatStore((s) => s.status);
  const error = useAiChatStore((s) => s.error);
  const autoReview = useAiChatStore((s) => s.autoReview);
  const model = useAiChatStore((s) => s.model);
  const sendMessage = useAiChatStore((s) => s.sendMessage);
  const setAutoReview = useAiChatStore((s) => s.setAutoReview);
  const setModel = useAiChatStore((s) => s.setModel);
  const revertTurn = useAiChatStore((s) => s.revertTurn);
  const stop = useAiChatStore((s) => s.stop);
  const close = useAiChatStore((s) => s.close);
  const sessionUsage = useAiChatStore((s) => s.sessionUsage);
  const chats = useAiChatStore((s) => s.chats);
  const currentChatId = useAiChatStore((s) => s.currentChatId);
  const newChat = useAiChatStore((s) => s.newChat);
  const loadChat = useAiChatStore((s) => s.loadChat);
  const deleteChat = useAiChatStore((s) => s.deleteChat);

  const selectedLayerIds = useEditorStore((s) => s.selectedLayerIds);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const draftLayers = usePagesStore((s) =>
    currentPageId ? s.draftsByPageId[currentPageId]?.layers : undefined,
  );
  const pages = usePagesStore((s) => s.pages);
  const collections = useCollectionsStore((s) => s.collections);

  const scrollRef = useRef<HTMLDivElement>(null);

  const isStreaming = status === 'streaming';

  const mentionCandidates = useMemo<Mention[]>(() => {
    const fromPages: Mention[] = pages.map((page) => ({ type: 'page', id: page.id, label: page.name }));
    const fromCollections: Mention[] = collections.map((collection) => ({
      type: 'collection',
      id: collection.id,
      label: collection.name,
    }));
    const fromLayers: Mention[] = draftLayers ? flattenLayerMentions(draftLayers) : [];
    return [...fromPages, ...fromCollections, ...fromLayers];
  }, [pages, collections, draftLayers]);

  const layerMentions = useMemo<Mention[]>(
    () => (draftLayers ? flattenLayerMentions(draftLayers) : []),
    [draftLayers],
  );

  // The canvas selection is sent to the agent as background context only — it is
  // not shown as a pill. Explicit pills come from the composer's @ menu / picker.
  const selectedRefs = useMemo<SelectedLayerRef[]>(() => {
    if (!selectedLayerIds.length || !draftLayers) return [];
    return selectedLayerIds
      .map((id) => {
        const layer = findLayerById(draftLayers, id);
        return layer ? { id, name: getLayerName(layer) } : null;
      })
      .filter((ref): ref is SelectedLayerRef => ref !== null);
  }, [selectedLayerIds, draftLayers]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const submit = (text: string, mentions: Mention[] = [], images: ImageAttachment[] = []) => {
    if ((!text.trim() && images.length === 0) || isStreaming) return;
    void sendMessage(text, {
      selectedLayers: selectedRefs,
      images,
      mentions,
      referenceUrls: parseUrls(text),
    });
  };

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden',
        embedded
          ? 'flex-1 min-h-0'
          : 'w-80 shrink-0 bg-background border-l h-full',
      )}
    >
      {embedded ? (
        <div className="flex items-center justify-between gap-2 px-4 pt-3 shrink-0">
          <ChatHistoryMenu
            chats={chats}
            currentChatId={currentChatId}
            onSelect={loadChat}
            onDelete={deleteChat}
          />
          <div className="flex items-center gap-1 shrink-0">
            <SessionUsageBadge usage={sessionUsage} />
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0"
              onClick={newChat}
              aria-label="New chat"
              title="New chat"
            >
              <Icon name="plus" className="size-3.5" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 px-4 h-12 shrink-0 border-b">
          <ChatHistoryMenu
            chats={chats}
            currentChatId={currentChatId}
            onSelect={loadChat}
            onDelete={deleteChat}
          />
          <div className="flex items-center gap-1 shrink-0">
            <SessionUsageBadge usage={sessionUsage} />
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0"
              onClick={newChat}
              aria-label="New chat"
              title="New chat"
            >
              <Icon name="plus" className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="size-7 p-0"
              onClick={close}
              aria-label="Close AI panel"
              title="Close"
            >
              <Icon name="x" className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar px-4 py-4 flex flex-col gap-4">
        {messages.length === 0 ? (
          <EmptyState onPick={submit} disabled={isStreaming} />
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id} message={message}
              isStreaming={isStreaming}
              onRevert={revertTurn}
            />
          ))
        )}

        {error && (
          <div className="text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
      </div>

      <div className="border-t p-3 shrink-0">
        <ChatComposer
          model={model}
          onModelChange={setModel}
          isStreaming={isStreaming}
          onStop={stop}
          onSubmit={submit}
          mentionCandidates={mentionCandidates}
          layerMentions={layerMentions}
        />
      </div>
    </div>
  );
}

function MarkdownText({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="text-xs leading-relaxed break-words [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-1.5 [&_ul]:ml-4 [&_ul]:list-disc [&_ol]:my-1.5 [&_ol]:ml-4 [&_ol]:list-decimal [&_li]:my-0.5 [&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-xs [&_h2]:font-semibold [&_h3]:font-semibold [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[11px] [&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Compact token count, e.g. 950 → "950", 12_300 → "12.3k", 2_100_000 → "2.1M". */
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const k = count / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = count / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/** Running token total for the active session, with a per-category tooltip. */
function SessionUsageBadge({ usage }: { usage: SessionUsage }) {
  const total =
    usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  if (total === 0) return null;

  const tooltip = [
    'Session tokens',
    `Input: ${usage.inputTokens.toLocaleString()}`,
    `Output: ${usage.outputTokens.toLocaleString()}`,
    `Cache write: ${usage.cacheWriteTokens.toLocaleString()}`,
    `Cache read: ${usage.cacheReadTokens.toLocaleString()}`,
  ].join('\n');

  return (
    <span
      title={tooltip}
      className="flex items-center gap-1 px-1.5 text-[11px] tabular-nums text-muted-foreground"
    >
      <Icon name="sparkles" className="size-3" />
      {formatTokens(total)}
    </span>
  );
}

/** Compact relative timestamp for the history list, e.g. "6h", "7d", "now". */
function compactTime(timestamp: number): string {
  const diffSecs = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSecs < 60) return 'now';
  const mins = Math.floor(diffSecs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

function ChatHistoryMenu({
  chats,
  currentChatId,
  onSelect,
  onDelete,
}: {
  chats: ChatSession[];
  currentChatId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const currentTitle = chats.find((chat) => chat.id === currentChatId)?.title ?? 'New chat';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="secondary"
          className="h-8 min-w-0 flex-1 justify-between gap-2 px-2.5 text-xs font-medium"
        >
          <span className="truncate">{currentTitle}</span>
          <Icon name="chevronDown" className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56">
        {chats.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No previous chats</div>
        ) : (
          chats.map((chat) => (
            <DropdownMenuItem
              key={chat.id}
              onSelect={() => onSelect(chat.id)}
              className={cn('group gap-2 pr-1.5', chat.id === currentChatId && 'bg-accent')}
            >
              <span className="flex-1 truncate text-xs">{chat.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground group-hover:hidden">
                {compactTime(chat.updatedAt)}
              </span>
              <button
                type="button"
                aria-label="Delete chat"
                title="Delete chat"
                className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground group-hover:flex"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDelete(chat.id);
                }}
              >
                <Icon name="trash" className="size-3" />
              </button>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyState({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
  return (
    <div className="flex flex-col gap-3 mt-2">
      <p className="text-xs text-muted-foreground">
        Describe what you want to build. The AI can create sections, edit elements, manage content, and more.
      </p>
      <div className="flex flex-col gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            disabled={disabled}
            onClick={() => onPick(suggestion)}
            className="text-left text-xs rounded-lg border bg-muted/40 hover:bg-muted px-3 py-2 transition-colors disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  isStreaming,
  onRevert,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  onRevert: (messageId: string) => void;
}) {
  if (message.role === 'user' && message.review) {
    return (
      <div className="self-stretch flex items-center gap-2 text-[11px] text-muted-foreground">
        <Icon name="eye" className="size-3 shrink-0" />
        <span>Reviewing the result…</span>
        {message.images?.[0] && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={message.images[0].dataUrl}
            alt="Review screenshot"
            className="ml-auto size-8 rounded object-cover border"
          />
        )}
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="self-end max-w-[85%] flex flex-col items-end gap-1.5">
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {message.images.map((image) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={image.id}
                src={image.dataUrl}
                alt="Attachment"
                className="size-20 rounded-lg object-cover border"
              />
            ))}
          </div>
        )}
        {message.text && (
          <div className="rounded-lg bg-primary text-primary-foreground px-3 py-2 text-xs whitespace-pre-wrap break-words">
            {message.text}
          </div>
        )}
        {message.reverted ? (
          <span className="text-[10px] text-muted-foreground">Changes reverted</span>
        ) : message.canRevert ? (
          <button
            type="button"
            onClick={() => onRevert(message.id)}
            disabled={isStreaming}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <Icon name="undo" className="size-2.5" />
            Revert changes
          </button>
        ) : null}
      </div>
    );
  }

  const isEmpty = !message.text && message.toolCalls.length === 0;

  return (
    <div className="flex flex-col gap-2">
      {message.parts && message.parts.length > 0 ? (
        <MessageParts parts={message.parts} />
      ) : (
        <>
          {message.toolCalls.length > 0 && (
            <div className="flex flex-col gap-1">
              {message.toolCalls.map((call) => (
                <ToolCallRow key={call.id} call={call} />
              ))}
            </div>
          )}
          {message.text && <MarkdownText text={message.text} />}
        </>
      )}

      {isEmpty && isStreaming && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          <span>Thinking...</span>
        </div>
      )}
    </div>
  );
}

function ToolCallRow({ call }: { call: ChatToolCall }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {call.ok === undefined ? (
        <Spinner className="size-3" />
      ) : (
        <Icon
          name={call.ok ? 'check' : 'x'}
          className={cn('size-3', call.ok ? 'text-foreground' : 'text-destructive')}
        />
      )}
      <span>{toolCallLabel(call.name)}</span>
    </div>
  );
}

/**
 * Render an assistant turn's text and tool calls in the order they streamed in.
 * Consecutive tool calls are grouped into a single tight checklist so they read
 * as one step, while text fragments render as separate markdown blocks.
 */
function MessageParts({ parts }: { parts: ChatMessagePart[] }) {
  const groups: Array<{ type: 'tools'; calls: ChatToolCall[] } | { type: 'text'; text: string }> = [];
  for (const part of parts) {
    if (part.type === 'tool') {
      const last = groups[groups.length - 1];
      if (last && last.type === 'tools') {
        last.calls.push(part.call);
      } else {
        groups.push({ type: 'tools', calls: [part.call] });
      }
    } else if (part.text) {
      groups.push({ type: 'text', text: part.text });
    }
  }

  return (
    <>
      {groups.map((group, index) =>
        group.type === 'tools' ? (
          <div key={index} className="flex flex-col gap-1">
            {group.calls.map((call) => (
              <ToolCallRow key={call.id} call={call} />
            ))}
          </div>
        ) : (
          <MarkdownText key={index} text={group.text} />
        ),
      )}
    </>
  );
}
