import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getServerSettings, SERVER_SETTINGS_QUERY_KEY, updateServerSettings } from '../api/settings'
import { GITHUB_WRITE_KINDS, type GithubWrites, type ServerSettings, type UpdateServerSettingsRequest } from '../domain/api'

const ALL_WRITES_OFF = Object.fromEntries(GITHUB_WRITE_KINDS.map((kind) => [kind, false])) as GithubWrites

/** The server-wide switches. Every kind of GitHub write is off while loading, on error and when the admin has it off. */
export function useServerSettings() {
  const query = useQuery({
    queryKey: SERVER_SETTINGS_QUERY_KEY,
    queryFn: ({ signal }) => getServerSettings(signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
  return {
    githubWrites: query.data?.githubWrites ?? ALL_WRITES_OFF,
    isLoading: query.isLoading,
    error: query.error,
  }
}

/** Changes the switches (admin only) and puts the server's answer into the cache. */
export function useUpdateServerSettings() {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (request: UpdateServerSettingsRequest) => updateServerSettings(request),
    onSuccess: (settings: ServerSettings) => queryClient.setQueryData(SERVER_SETTINGS_QUERY_KEY, settings),
  })
  return {
    update: mutation.mutateAsync,
    isPending: mutation.isPending,
    error: mutation.error,
  }
}
