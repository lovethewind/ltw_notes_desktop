import type { NotesDesktopApi } from './types'

declare global {
  interface Window {
    notesDesktop: NotesDesktopApi
  }
}

export {}
