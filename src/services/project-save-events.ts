/** Emitted only after an author explicitly saves successfully. Database writes,
 * generation and applying a received sync batch must not trigger cloud work. */
export const PROJECT_MANUALLY_SAVED = 'ai-novel:project-manually-saved'

export function announceProjectManuallySaved(projectPath: string | undefined): void {
  if (projectPath && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PROJECT_MANUALLY_SAVED, { detail: { projectPath } }))
  }
}
