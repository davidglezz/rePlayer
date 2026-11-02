import { describe, expect, it } from 'vitest';
import { readTags } from '../src/tags';

function ascii(text: string): Buffer { return Buffer.from(text, 'ascii'); }
function u16le(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }
function u32be(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; }

function riffChunk(id: string, data: Buffer): Buffer {
    return Buffer.concat([ascii(id), u32le(data.length), data, data.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

function makeTaggedWav(): Uint8Array {
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

function makeTaggedFlac(): Uint8Array {
    const streamInfo = Buffer.alloc(34);
    const streamHeader = Buffer.from([0x00, 0x00, 0x00, 34]);
    const vendor = Buffer.from('rePlayer', 'utf8');
    const comments = ['TITLE=FLAC Title', 'ARTIST=FLAC Artist'];
    const parts = [u32le(vendor.length), vendor, u32le(comments.length)];
    for (const comment of comments) {
        const bytes = Buffer.from(comment, 'utf8');
        parts.push(u32le(bytes.length), bytes);
    }
    const commentData = Buffer.concat(parts);
    const commentHeader = Buffer.from([
        0x84,
        (commentData.length >> 16) & 0xff,
        (commentData.length >> 8) & 0xff,
        commentData.length & 0xff,
    ]);
    return Buffer.concat([ascii('fLaC'), streamHeader, streamInfo, commentHeader, commentData]);
}

function id3Frame(id: string, text: string): Buffer {
    const data = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
    return Buffer.concat([ascii(id), u32be(data.length), Buffer.from([0, 0]), data]);
}

function makeTaggedMp3(): Uint8Array {
    const frames = Buffer.concat([id3Frame('TIT2', 'MP3 Title'), id3Frame('TPE1', 'MP3 Artist')]);
    const size = frames.length;
    const syncsafe = Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
    return Buffer.concat([ascii('ID3'), Buffer.from([3, 0, 0]), syncsafe, frames]);
}

function makeId3v1(): Uint8Array {
    const tag = Buffer.alloc(128);
    tag.write('TAG', 0);
    tag.write('v1 Title', 3, 'latin1');
    tag.write('v1 Artist', 33, 'latin1');
    return tag;
}

describe('tag reader', () => {
    it('reads WAV LIST/INFO fields', () => {
        expect(readTags(makeTaggedWav(), 1)).toEqual({ title: 'WAV Title', artist: 'WAV Artist' });
    });

    it('reads FLAC Vorbis comments', () => {
        expect(readTags(makeTaggedFlac(), 2)).toEqual({ title: 'FLAC Title', artist: 'FLAC Artist' });
    });

    it('reads MP3 ID3v2 frames', () => {
        expect(readTags(makeTaggedMp3(), 3)).toEqual({ title: 'MP3 Title', artist: 'MP3 Artist' });
    });

    it('falls back to an ID3v1 tag', () => {
        expect(readTags(makeId3v1(), 3)).toEqual({ title: 'v1 Title', artist: 'v1 Artist' });
    });

    it('ignores unknown formats and short files', () => {
        expect(readTags(new Uint8Array([1, 2, 3]), 9)).toEqual({ title: '', artist: '' });
        expect(readTags(new Uint8Array([1, 2, 3]), 1)).toEqual({ title: '', artist: '' });
    });

    it('survives malformed data without throwing', () => {
        const garbage = new Uint8Array(64).fill(0xff);
        expect(() => readTags(garbage, 1)).not.toThrow();
        expect(() => readTags(garbage, 2)).not.toThrow();
        expect(() => readTags(garbage, 3)).not.toThrow();
    });
});
