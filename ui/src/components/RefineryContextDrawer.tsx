import type { RefineryMessage } from "@paperclipai/shared";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";

/**
 * Refinery "inspect context" drawer (Task 11) — shows the user exactly which
 * messages will be sent to the model on the next turn. This is deliberately
 * NOT a new read: it filters the SAME `refinery.messages(sessionId)` query
 * the chat pane already holds, using the identical `!contextExcluded`
 * predicate the server's `buildHistory` applies (see
 * `server/src/services/refinery.ts`). That shared predicate is the whole
 * point of the feature — the drawer's list and the server's next-request
 * history are guaranteed to match by construction, not by convention.
 *
 * Toggling context never touches `body`; this drawer only ever reads it.
 */

const PREVIEW_LENGTH = 200;

function roleLabel(role: RefineryMessage["role"]): string {
  return role === "user" ? "You" : "Assistant";
}

export interface RefineryContextDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: RefineryMessage[];
}

export function RefineryContextDrawer({ open, onOpenChange, messages }: RefineryContextDrawerProps) {
  const included = messages.filter((m) => !m.contextExcluded);
  const totalChars = included.reduce((sum, m) => sum + (m.body?.length ?? 0), 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 sm:max-w-md"
        data-testid="refinery-context-drawer"
      >
        <SheetHeader>
          <SheetTitle>Context sent to the model</SheetTitle>
          <SheetDescription>
            The system prompt and this company&rsquo;s org context pack are prepended
            server-side and aren&rsquo;t shown here. Below is exactly the message
            history — in order — that will be sent on the next turn.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" data-testid="refinery-context-drawer-list">
          {included.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages included in context.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {included.map((message) => {
                const body = message.body ?? "";
                const preview =
                  body.length > PREVIEW_LENGTH ? `${body.slice(0, PREVIEW_LENGTH)}…` : body;
                return (
                  <li
                    key={message.id}
                    data-testid="refinery-context-drawer-row"
                    className="rounded-md border border-border p-2"
                  >
                    <Badge variant={message.role === "user" ? "default" : "secondary"} className="mb-1">
                      {roleLabel(message.role)}
                    </Badge>
                    <p className="whitespace-pre-wrap break-words text-sm text-foreground">{preview}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div
          className="shrink-0 border-t border-border px-4 py-3 text-xs text-muted-foreground"
          data-testid="refinery-context-drawer-char-count"
        >
          {included.length} message{included.length === 1 ? "" : "s"} included · {totalChars.toLocaleString()}{" "}
          characters
        </div>
      </SheetContent>
    </Sheet>
  );
}
