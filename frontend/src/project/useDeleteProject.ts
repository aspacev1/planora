import { useMutation, useQueryClient } from "@tanstack/react-query";

import { PROJECTS_QUERY_KEY, deleteProject, projectQueryKey } from "../api/projects";
import type { Project } from "../api/projects";
import { useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";

/** What is being deleted. The name is not for the request but for the toast; see below why it is here. */
export type DeletedProject = { id: string; name: string };

/**
 * Deleting a project together with everything that must happen in the cache afterwards.
 *
 * A separate hook rather than a mutation inside a screen: a project can be parted with from its
 * settings and from a card in the list, and there are three rules after a success — remove the
 * project from the list, throw out its state and name to the person what was deleted. A second set
 * of these rules would diverge from the first on the very first edit, and diverge silently.
 *
 * The name arrives with the request rather than being read from the cache in the handler: by the
 * time of the success the project is neither on the server nor in the cache — while what has to be
 * named in the toast is precisely what was deleted.
 *
 * `onDeleted` is what the screen itself does after the deletion: the settings go to the list, the
 * list closes the confirmation dialog. The cache has nothing to do with that, and the hook does not
 * decide it for the screen.
 */
export function useDeleteProject({ onDeleted }: { onDeleted?: () => void } = {}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const showToast = useToast();

  return useMutation({
    mutationFn: ({ id }: DeletedProject) => deleteProject(id),
    onSuccess: (_result, { id, name }: DeletedProject) => {
      // The list is edited in place rather than merely marked stale: until the refetch answers it
      // would show a card of something that no longer exists — and a person who pressed "Delete"
      // would spend a second looking at something undone.
      queryClient.setQueryData(PROJECTS_QUERY_KEY, (projects: Project[] | undefined) =>
        projects?.filter((project) => project.id !== id),
      );
      // The project's cache is not invalidated but thrown out: a refetch by this key can now only
      // answer with a 404.
      queryClient.removeQueries({ queryKey: projectQueryKey(id) });
      // And it is refetched all the same: an in-place edit is a guess about what is on the server,
      // and the list must agree with it rather than with the guess.
      void queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
      // The toast deliberately offers no undo — the revision journal went with the project, and
      // there is nowhere to bring the state back from; that is said honestly in the confirmation the
      // person has just read too.
      showToast({ message: t("settings.project.deleted", { name }) });
      onDeleted?.();
    },
  });
}
