// Global (Carbon) styles first, so component styles imported by App can override them.
import './styles/index.scss'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Anonymous GitHub clients get 60 requests an hour, so only refetch
      // when the data is old or the user asks for it.
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
