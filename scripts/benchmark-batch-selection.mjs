#!/usr/bin/env node

import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    json: { type: 'boolean', default: false },
    kind: { type: 'string', default: 'episode' },
    runs: { type: 'string', default: '5' },
    sizes: { type: 'string', default: '100,500,1000,2500,5000,7765' }
  }
})

const runs = Number(values.runs)
const sizes = values.sizes.split(',').map(Number)
const kind = values.kind

if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer')
if (sizes.some((size) => !Number.isInteger(size) || size < 1)) throw new Error('--sizes must be comma-separated positive integers')
if (kind !== 'book' && kind !== 'episode') throw new Error('--kind must be book or episode')

let sink = 0

function makeSelection(count) {
  const podcastCount = Math.max(1, Math.ceil(count / 50))
  const selectedItems = Array.from({ length: count }, (_, index) =>
    kind === 'episode'
      ? {
          selectionKey: `ep:episode-${index}`,
          libraryItemId: `podcast-${index % podcastCount}`,
          episodeId: `episode-${index}`,
          hasTracks: true
        }
      : {
          selectionKey: `li:book-${index}`,
          libraryItemId: `book-${index}`,
          hasTracks: true,
          title: `Benchmark book ${index}`,
          downloadSize: 100_000_000 + index
        }
  )
  const mediaProgress = selectedItems.map((item) =>
    kind === 'episode'
      ? { libraryItemId: item.libraryItemId, mediaItemId: item.episodeId, isFinished: true }
      : { libraryItemId: item.libraryItemId, isFinished: true }
  )
  return { selectedItems, mediaProgress }
}

function findProgressForSelectedItem(item, mediaProgress) {
  if (item.episodeId) {
    return mediaProgress.find((entry) => (entry.mediaItemId ?? entry.episodeId) === item.episodeId)
  }
  return mediaProgress.find((entry) => entry.libraryItemId === item.libraryItemId && !entry.episodeId)
}

// Mirrors useSelectionBatchState in AppBarSelectionOverlay. The all-finished
// case visits every selected item and linearly searches mediaProgress for it.
function currentSelectionState(selectedItems, mediaProgress) {
  const allPlayable = selectedItems.every((item) => item.hasTracks)
  const allFinished = selectedItems.every((item) => {
    return Boolean(findProgressForSelectedItem(item, mediaProgress)?.isFinished)
  })
  return Number(allPlayable) + Number(allFinished)
}

function indexedSelectionState(selectedItems, mediaProgress) {
  const progressByItem = new Map(
    mediaProgress.map((entry) => {
      const episodeId = entry.mediaItemId ?? entry.episodeId
      return [episodeId ? `ep:${episodeId}` : `li:${entry.libraryItemId}`, entry]
    })
  )
  const allPlayable = selectedItems.every((item) => item.hasTracks)
  const allFinished = selectedItems.every((item) => Boolean(progressByItem.get(item.episodeId ? `ep:${item.episodeId}` : `li:${item.libraryItemId}`)?.isFinished))
  return Number(allPlayable) + Number(allFinished)
}

function prepareActionInputs(selectedItems) {
  const uniqueLibraryItemIds = [...new Set(selectedItems.map((item) => item.libraryItemId))]
  const playlistItems = selectedItems.map((item) => ({ libraryItemId: item.libraryItemId, episodeId: item.episodeId ?? null }))
  const finishedItems = selectedItems.map((item) => ({
    libraryItemId: item.libraryItemId,
    episodeId: item.episodeId,
    isFinished: false
  }))
  return { uniqueLibraryItemIds, playlistItems, finishedItems }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function measure(fn) {
  sink += fn()
  const samples = []
  for (let run = 0; run < runs; run++) {
    const start = performance.now()
    sink += fn()
    samples.push(performance.now() - start)
  }
  return { medianMs: median(samples), meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length }
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value))
}

const results = sizes.map((count) => {
  const { selectedItems, mediaProgress } = makeSelection(count)
  const actionInputs = prepareActionInputs(selectedItems)
  const current = measure(() => currentSelectionState(selectedItems, mediaProgress))
  const indexed = measure(() => indexedSelectionState(selectedItems, mediaProgress))
  const actionPreparation = measure(() => {
    const prepared = prepareActionInputs(selectedItems)
    return prepared.uniqueLibraryItemIds.length + prepared.playlistItems.length + prepared.finishedItems.length
  })

  return {
    items: count,
    current,
    indexed,
    speedup: current.medianMs / indexed.medianMs,
    actionPreparation,
    bytes: {
      selectionSession: byteLength({ libraryId: 'benchmark', selectionKind: kind, items: selectedItems, returnPath: '/library/benchmark' }),
      playlist: byteLength(actionInputs.playlistItems),
      finished: byteLength(actionInputs.finishedItems),
      uniqueLibraryItemIds: byteLength(actionInputs.uniqueLibraryItemIds)
    }
  }
})

if (values.json) {
  process.stdout.write(`${JSON.stringify({ node: process.version, kind, runs, results }, null, 2)}\n`)
  process.exitCode = sink < 0 ? 1 : 0
} else {
  const milliseconds = (value) => (value < 1 ? value.toFixed(3) : value.toFixed(2))
  const kibibytes = (value) => (value / 1024).toFixed(1)

  console.log(`Discovery benchmark on Node ${process.version}, ${runs} measured runs after one warm-up`)
  console.log(`Synthetic ${kind} selection with an equally sized all-finished progress list; no network or server work`)
  console.log('')
  console.log('| Items | Current overlay median | Indexed median | Speedup | Action input prep median |')
  console.log('|---:|---:|---:|---:|---:|')
  for (const result of results) {
    console.log(
      `| ${result.items.toLocaleString('en-US')} | ${milliseconds(result.current.medianMs)} ms | ${milliseconds(result.indexed.medianMs)} ms | ${result.speedup.toFixed(1)}x | ${milliseconds(result.actionPreparation.medianMs)} ms |`
    )
  }

  console.log('')
  console.log('| Items | Batch-edit session | Playlist payload | Finished payload | Unique ID payload |')
  console.log('|---:|---:|---:|---:|---:|')
  for (const result of results) {
    console.log(
      `| ${result.items.toLocaleString('en-US')} | ${kibibytes(result.bytes.selectionSession)} KiB | ${kibibytes(result.bytes.playlist)} KiB | ${kibibytes(result.bytes.finished)} KiB | ${kibibytes(result.bytes.uniqueLibraryItemIds)} KiB |`
    )
  }
}
