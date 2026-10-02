import { ArrowRight } from '@carbon/icons-react'
import {
  Button,
  Form,
  Layer,
  PasswordInput,
  Stack,
  TextInput,
  Tile,
} from '@carbon/react'
import { useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { parseRepoInput } from '../domain/repoRef'
import type { RepoRef } from '../domain/types'
import { BoardList } from '../board/BoardList'
import { V1ImportPrompt } from '../board/V1ImportPrompt'
import { SNAPSHOT_QUERY_ROOT } from '../hooks/useRepoSnapshot'
import { useSession } from '../state/session'
import { useSettings } from '../state/settings'
import { GitHubAccessNotice } from './auth/GitHubAccessNotice'
import './app.scss'

interface ConnectPageProps {
  onOpen: (repo: RepoRef) => void
}

export function ConnectPage({ onOpen }: ConnectPageProps) {
  const queryClient = useQueryClient()
  const savedToken = useSettings((state) => state.token)
  const setToken = useSettings((state) => state.setToken)
  const browserToken = useSession((state) => state.session?.githubAccess.mode !== 'server')

  const [repoInput, setRepoInput] = useState('')
  const [tokenInput, setTokenInput] = useState(savedToken)
  const [submitted, setSubmitted] = useState(false)
  const repo = parseRepoInput(repoInput)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitted(true)
    if (!repo) return
    if (browserToken && tokenInput.trim() !== savedToken) {
      setToken(tokenInput)
      queryClient.removeQueries({ queryKey: [SNAPSHOT_QUERY_ROOT] })
    }
    onOpen(repo)
  }

  return (
    <div className="connect">
      <title>Urutau</title>
      <div className="connect__intro">
        <h1 className="connect__title">Plan GitHub issues on a kanban board</h1>
        <p className="connect__lead">
          Point Urutau at a repository to pull in its issues and labels. Your buckets and card
          positions are saved on this server and shared with everyone who has an account; nothing
          is written back to GitHub.
        </p>
      </div>

      <V1ImportPrompt />

      <Tile className="connect__form">
        <Layer>
          <Form onSubmit={handleSubmit} aria-label="Open a repository" noValidate>
          <Stack gap={6}>
            <TextInput
              id="connect-repo"
              labelText="GitHub repository"
              placeholder="owner/name or https://github.com/owner/name"
              value={repoInput}
              onChange={(event) => setRepoInput(event.target.value)}
              invalid={submitted && !repo}
              invalidText="Enter a repository as owner/name, or paste its GitHub URL."
              autoComplete="off"
              spellCheck={false}
            />
            {browserToken ? (
              <>
                <GitHubAccessNotice />
                <PasswordInput
                  id="connect-token"
                  labelText="Personal access token (optional)"
                  helperText="Needed for private repositories and to raise GitHub's rate limit. A fine-grained token with read-only Issues access is enough. It is stored only in this browser and sent only to GitHub."
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  autoComplete="off"
                />
              </>
            ) : (
              <p className="connect__note">GitHub is read through your Keycloak link.</p>
            )}
            <div>
              <Button type="submit" renderIcon={ArrowRight}>
                Open board
              </Button>
            </div>
          </Stack>
          </Form>
        </Layer>
      </Tile>

      <BoardList onOpen={onOpen} />
    </div>
  )
}
