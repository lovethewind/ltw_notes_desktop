const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openNotesDatabase } = require('../electron/database.cjs')

test('标签页会话和滚动位置只保存在当前本地数据库', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltw-notes-workspace-session-'))
  const repository = openNotesDatabase(directory)
  try {
    const first = repository.createNote()
    const second = repository.createNote()

    repository.saveWorkspaceSession({
      tabs: [
        { noteId: first.id, isPinned: true },
        { noteId: second.id, isPinned: false }
      ],
      activeNoteId: second.id
    })
    repository.saveNoteViewState(first.id, 128)
    repository.saveNoteViewState(second.id, 768)

    assert.deepEqual(repository.getWorkspaceSession(), {
      tabs: [
        { noteId: first.id, isPinned: true, scrollTop: 128 },
        { noteId: second.id, isPinned: false, scrollTop: 768 }
      ],
      activeNoteId: second.id
    })
    assert.equal(Object.hasOwn(repository.exportBackup(), 'workspaceSession'), false)

    repository.setNoteDeleted(second.id, true)
    repository.deleteNotePermanently(second.id)
    assert.deepEqual(repository.getWorkspaceSession(), {
      tabs: [{ noteId: first.id, isPinned: true, scrollTop: 128 }],
      activeNoteId: null
    })
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
