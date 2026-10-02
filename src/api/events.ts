/** Opens the live-update stream for one repository; the caller closes it. */
export function openBoardEvents(repoKey: string): EventSource {
  return new EventSource('api/events?repo=' + encodeURIComponent(repoKey))
}
