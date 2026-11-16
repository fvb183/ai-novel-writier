import { afterEach, expect, it } from 'vitest'
import { acceptDriveProjects, drivePathKey, useDriveSyncStore } from '../drive-sync-store'
afterEach(() => useDriveSyncStore.setState({ projects: {} }))
it('keeps case-distinct Android novels independently enabled', () => {
  acceptDriveProjects([{ path: '/android/files/Book', enabled: true }, { path: '/android/files/book', enabled: false }])
  expect(Object.keys(useDriveSyncStore.getState().projects)).toHaveLength(2)
  expect(useDriveSyncStore.getState().projects[drivePathKey('/android/files/Book')]).toBe(true)
  expect(useDriveSyncStore.getState().projects[drivePathKey('/android/files/book')]).toBe(false)
})
it('uses the same preference for equivalent Windows spellings', () => {
  acceptDriveProjects([{ path: 'D:\\Novels\\Book', enabled: true }])
  expect(useDriveSyncStore.getState().projects[drivePathKey('d:/novels/Book/')]).toBe(true)
})
