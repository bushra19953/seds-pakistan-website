import React from 'react'
import { render, fireEvent, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import MultiSelectUserCombobox from '@/components/admin/multi-select-user-combobox'

const users = Array.from({ length: 6 }).map((_, i) => ({
  id: `u${i+1}`,
  uid: `u${i+1}`,
  displayName: `User ${i+1}`,
  email: `user${i+1}@example.com`,
  chapterId: i < 3 ? 'ist' : 'nust',
  role: i % 2 === 0 ? 'member' : 'advisor',
}))

test('bulk select and deselect filtered', () => {
  const onChange = jest.fn()
  render(<MultiSelectUserCombobox value={[]} onChange={onChange} usersOverride={users} />)
  const trigger = screen.getByRole('combobox')
  fireEvent.click(trigger)
  const bulkButton = screen.getByRole('button', { name: /Select all filtered \(/i })
  fireEvent.click(bulkButton)
  expect(onChange).toHaveBeenCalled()
  const lastArgs = onChange.mock.calls[onChange.mock.calls.length - 1][0]
  expect(lastArgs.length).toBe(users.length)
  const deselectButton = screen.getByRole('button', { name: /Deselect all filtered \(/i })
  fireEvent.click(deselectButton)
  const lastArgs2 = onChange.mock.calls[onChange.mock.calls.length - 1][0]
  expect(lastArgs2.length).toBe(0)
})

test('toggle individual user checkbox', () => {
  const onChange = jest.fn()
  render(<MultiSelectUserCombobox value={[]} onChange={onChange} usersOverride={users} />)
  const trigger = screen.getByRole('combobox')
  fireEvent.click(trigger)
  const rowCheckboxes = screen.getAllByRole('checkbox')
  const first = rowCheckboxes.find(el => el.getAttribute('aria-label')?.toLowerCase().includes('select user 1')) || rowCheckboxes[0]
  fireEvent.click(first)
  const lastArgs = onChange.mock.calls[onChange.mock.calls.length - 1][0]
  expect(lastArgs.includes('u1')).toBe(true)
  fireEvent.click(first)
  const lastArgs2 = onChange.mock.calls[onChange.mock.calls.length - 1][0]
  expect(lastArgs2.includes('u1')).toBe(false)
})