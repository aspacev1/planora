import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { addComment, commentsQueryKey, listComments } from "../api/comments";
import { CommentThread } from "../comments/CommentThread";

/**
 * A task's discussion.
 *
 * Oldest to newest — that is how the server gives them, and turning the thread around in the browser
 * would mean keeping the conversation's order in two places.
 *
 * There is no optimistic insertion here, unlike the field editing next to it. The difference is not
 * laziness: a change to a task has an inverse operation, and a server refusal returns the state
 * without a trace. A reply has no rollback — showing it before the confirmation means one day showing
 * a reply that does not exist, with nothing left to take it off the screen with.
 *
 * A refusal of the feed breaks nothing: the block is simply absent, and the card above works as it
 * worked. The same argument as with a task's history.
 */
export function Comments({ projectId, taskId }: { projectId: string; taskId: string }) {
  const client = useQueryClient();

  const thread = useQuery({
    queryKey: commentsQueryKey(projectId, taskId),
    queryFn: () => listComments(projectId, taskId),
    retry: false,
  });

  const send = useMutation({
    mutationFn: (body: string) => addComment(projectId, body, taskId),
    onSuccess: () => {
      // Both the task's feed and the project's: the reply landed in both, and refreshing only the one
      // in sight means leaving the second to lie until a navigation.
      client.invalidateQueries({ queryKey: commentsQueryKey(projectId) });
    },
  });

  if (thread.error) return null;

  return (
    <div className="panel__comments">
      <CommentThread
        comments={thread.data ?? []}
        loading={thread.isPending}
        onSend={(input) => send.mutateAsync(input.body)}
        sending={send.isPending}
        sendError={send.error}
      />
    </div>
  );
}
