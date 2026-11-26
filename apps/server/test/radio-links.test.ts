import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storedUserSettingsSchema, updateUserSettingsBodySchema, youtubeVideoId } from '@sillage/protocol'

test('youtubeVideoId reads the usual YouTube links and nothing posing as one', () => {
  const id = 'jfKfPfyJRdk'
  for (const link of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?feature=share&v=${id}&t=30`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/live/${id}?si=x`,
    `https://m.youtube.com/shorts/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `  https://www.youtube.com/watch?v=${id}  `,
  ]) assert.equal(youtubeVideoId(link), id, link)
  for (const link of [
    `https://evil.example/watch?v=${id}`,
    `https://youtube.com.evil.example/watch?v=${id}`,
    `https://evil.example/?u=https://www.youtube.com/watch?v=${id}`,
    'https://www.youtube.com/@LofiGirl/live',
    'https://www.youtube.com/watch?v=short',
    `javascript:alert(1)//youtube.com/watch?v=${id}`,
    'https://clau.de/radio',
  ]) assert.equal(youtubeVideoId(link), null, link)
})

test('the radio setting accepts a YouTube link or null, and a stored bad value falls back to Claude FM', () => {
  assert.equal(updateUserSettingsBodySchema.parse({ radioUrl: null }).radioUrl, null)
  assert.equal(updateUserSettingsBodySchema.parse({ radioUrl: 'https://youtu.be/jfKfPfyJRdk' }).radioUrl, 'https://youtu.be/jfKfPfyJRdk')
  assert.throws(() => updateUserSettingsBodySchema.parse({ radioUrl: 'https://example.com/stream.mp3' }))
  assert.equal(storedUserSettingsSchema.parse({ radioUrl: 'nope' }).radioUrl, null)
  assert.equal(storedUserSettingsSchema.parse({}).radioUrl, null)
})
