// Node test for the tag reader (WAV INFO, FLAC Vorbis comments, ID3v2/ID3v1).
//
//   node wasm/test-tags.mjs

import { readTags } from './web/tags.js';

function ascii(text) { return Buffer.from(text, 'ascii'); }
function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }
function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; }

function riffChunk(id, data) {
    return Buffer.concat([ascii(id), u32le(data.length), data, data.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

function check(condition, message) {
    if (!condition)
        throw new Error(message);
}

function makeTaggedWav() {
    const format = Buffer.concat([u16le(1), u16le(2), u32le(44100), u32le(44100 * 4), u16le(4), u16le(16)]);
    const info = Buffer.concat([
        ascii('INFO'),
        riffChunk('INAM', Buffer.from('WAV Title\0', 'latin1')),
        riffChunk('IART', Buffer.from('WAV Artist\0', 'latin1')),
    ]);
    const body = Buffer.concat([
        ascii('WAVE'),
        riffChunk('fmt ', format),
        riffChunk('LIST', info),
        riffChunk('data', Buffer.alloc(4)),
    ]);
    return Buffer.concat([ascii('RIFF'), u32le(body.length), body]);
}

function makeTaggedFlac() {
    const streamInfo = Buffer.alloc(34);
    const streamHeader = Buffer.from([0x00, 0x00, 0x00, 34]); // last=0, type=0, len=34
    const vendor = Buffer.from('rePlayer', 'utf8');
    const comments = ['TITLE=FLAC Title', 'ARTIST=FLAC Artist'];
    const parts = [u32le(vendor.length), vendor, u32le(comments.length)];
    for (const comment of comments) {
        const bytes = Buffer.from(comment, 'utf8');
        parts.push(u32le(bytes.length), bytes);
    }
    const commentData = Buffer.concat(parts);
    const commentHeader = Buffer.from([
        0x84, // last=1, type=4
        (commentData.length >> 16) & 0xff,
        (commentData.length >> 8) & 0xff,
        commentData.length & 0xff,
    ]);
    return Buffer.concat([ascii('fLaC'), streamHeader, streamInfo, commentHeader, commentData]);
}

function id3Frame(id, text) {
    const data = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]); // encoding 3 = UTF-8
    return Buffer.concat([ascii(id), u32be(data.length), Buffer.from([0, 0]), data]);
}

function makeTaggedMp3() {
    const frames = Buffer.concat([id3Frame('TIT2', 'MP3 Title'), id3Frame('TPE1', 'MP3 Artist')]);
    const size = frames.length;
    const syncsafe = Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
    return Buffer.concat([ascii('ID3'), Buffer.from([3, 0, 0]), syncsafe, frames]);
}

function makeId3v1() {
    const tag = Buffer.alloc(128);
    tag.write('TAG', 0);
    tag.write('v1 Title', 3, 'latin1');
    tag.write('v1 Artist', 33, 'latin1');
    return tag;
}

const wav = readTags(makeTaggedWav(), 1);
check(wav.title === 'WAV Title', `WAV title: ${wav.title}`);
check(wav.artist === 'WAV Artist', `WAV artist: ${wav.artist}`);

const flac = readTags(makeTaggedFlac(), 2);
check(flac.title === 'FLAC Title', `FLAC title: ${flac.title}`);
check(flac.artist === 'FLAC Artist', `FLAC artist: ${flac.artist}`);

const mp3 = readTags(makeTaggedMp3(), 3);
check(mp3.title === 'MP3 Title', `ID3 title: ${mp3.title}`);
check(mp3.artist === 'MP3 Artist', `ID3 artist: ${mp3.artist}`);

const v1 = readTags(makeId3v1(), 3);
check(v1.title === 'v1 Title', `ID3v1 title: ${v1.title}`);
check(v1.artist === 'v1 Artist', `ID3v1 artist: ${v1.artist}`);

const unknown = readTags(new Uint8Array([1, 2, 3]), 9);
check(unknown.title === '' && unknown.artist === '', 'unknown format');

console.log('ok: WAV INFO, FLAC comments, ID3v2, ID3v1');
