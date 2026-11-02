// Small tag reader for the formats that dr_libs does not expose metadata for:
// WAV LIST/INFO, FLAC Vorbis comments and MP3 ID3v2/ID3v1. It only reads the
// headers; no audio data is touched.

export interface Tags {
    title: string;
    artist: string;
}

function fourcc(bytes: Uint8Array, offset: number): string {
    if (offset + 4 > bytes.length)
        return '';
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function startsWith(bytes: Uint8Array, offset: number, text: string): boolean {
    if (offset < 0 || offset + text.length > bytes.length)
        return false;
    for (let i = 0; i < text.length; i++) {
        if (bytes[offset + i] !== text.charCodeAt(i))
            return false;
    }
    return true;
}

function decodeText(bytes: Uint8Array): string {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0)
        end--;
    if (end === 0)
        return '';
    const slice = bytes.subarray(0, end);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(slice).trim();
    } catch (e) {
        try { return new TextDecoder('windows-1252').decode(slice).trim(); } catch (e2) { return ''; }
    }
}

function decodeId3Text(bytes: Uint8Array): string {
    if (!bytes.length)
        return '';
    const encoding = bytes[0];
    let data = bytes.subarray(1);

    if (encoding === 1 || encoding === 2) {
        let end = data.length;
        while (end >= 2 && data[end - 1] === 0 && data[end - 2] === 0)
            end -= 2;
        let slice = data.subarray(0, end);
        let codec = encoding === 2 ? 'utf-16be' : 'utf-16le';
        if (encoding === 1 && slice.length >= 2) {
            if (slice[0] === 0xFF && slice[1] === 0xFE) {
                codec = 'utf-16le';
                slice = slice.subarray(2);
            } else if (slice[0] === 0xFE && slice[1] === 0xFF) {
                codec = 'utf-16be';
                slice = slice.subarray(2);
            }
        }
        try { return new TextDecoder(codec).decode(slice).trim(); } catch (e) { return ''; }
    }

    const end = data.indexOf(0);
    return decodeText(data.subarray(0, end < 0 ? data.length : end));
}

function readWav(bytes: Uint8Array): Partial<Tags> {
    if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WAVE')
        return {};
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let title = '';
    let artist = '';
    let offset = 12;

    while (offset + 8 <= bytes.length) {
        const id = fourcc(bytes, offset);
        const size = view.getUint32(offset + 4, true);
        const start = offset + 8;
        const end = Math.min(start + size, bytes.length);

        if (id === 'LIST' && start + 4 <= end && fourcc(bytes, start) === 'INFO') {
            let cursor = start + 4;
            while (cursor + 8 <= end) {
                const subId = fourcc(bytes, cursor);
                const subSize = view.getUint32(cursor + 4, true);
                const value = decodeText(bytes.subarray(cursor + 8, Math.min(cursor + 8 + subSize, bytes.length)));
                if (subId === 'INAM')
                    title = value;
                else if (subId === 'IART')
                    artist = value;
                cursor += 8 + subSize + (subSize & 1);
            }
            break;
        }

        offset = start + size + (size & 1);
    }
    return { title, artist };
}

function readFlac(bytes: Uint8Array): Partial<Tags> {
    if (fourcc(bytes, 0) !== 'fLaC')
        return {};
    let offset = 4;

    while (offset + 4 <= bytes.length) {
        const header = bytes[offset];
        const isLast = (header & 0x80) !== 0;
        const type = header & 0x7f;
        const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
        const start = offset + 4;
        if (start + length > bytes.length)
            break;

        if (type === 4) {
            const view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
            let cursor = 0;
            if (cursor + 4 > length)
                return {};
            const vendorLength = view.getUint32(cursor, true);
            cursor += 4 + vendorLength;
            if (cursor + 4 > length)
                return {};
            const count = view.getUint32(cursor, true);
            cursor += 4;

            let title = '';
            let artist = '';
            for (let i = 0; i < count && cursor + 4 <= length; i++) {
                const size = view.getUint32(cursor, true);
                cursor += 4;
                if (cursor + size > length)
                    break;
                const comment = new TextDecoder('utf-8').decode(bytes.subarray(start + cursor, start + cursor + size));
                cursor += size;
                const equals = comment.indexOf('=');
                if (equals < 0)
                    continue;
                const key = comment.slice(0, equals).toUpperCase();
                const value = comment.slice(equals + 1);
                if (key === 'TITLE')
                    title = value;
                else if (key === 'ARTIST')
                    artist = value;
            }
            return { title, artist };
        }

        offset = start + length;
        if (isLast)
            break;
    }
    return {};
}

function readMp3(bytes: Uint8Array): Partial<Tags> {
    let title = '';
    let artist = '';

    if (bytes.length >= 10 && startsWith(bytes, 0, 'ID3')) {
        const version = bytes[3];
        const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
        let offset = 10;
        const end = Math.min(10 + size, bytes.length);

        while (offset + 10 <= end) {
            const id = fourcc(bytes, offset);
            const frameSize = version === 4
                ? ((bytes[offset + 4] & 0x7f) << 21) | ((bytes[offset + 5] & 0x7f) << 14) | ((bytes[offset + 6] & 0x7f) << 7) | (bytes[offset + 7] & 0x7f)
                : (((bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7]) >>> 0);
            const start = offset + 10;
            if (frameSize <= 0 || start + frameSize > end)
                break;
            if (id === 'TIT2' || id === 'TPE1') {
                const value = decodeId3Text(bytes.subarray(start, start + frameSize));
                if (id === 'TIT2')
                    title = value;
                else
                    artist = value;
            }
            offset = start + frameSize;
        }
    }

    if (!title && !artist && bytes.length >= 128 && startsWith(bytes, bytes.length - 128, 'TAG')) {
        const tag = bytes.subarray(bytes.length - 128);
        title = decodeText(tag.subarray(3, 33));
        artist = decodeText(tag.subarray(33, 63));
    }
    return { title, artist };
}

export function readTags(bytes: Uint8Array, format: number): Tags {
    try {
        if (format === 1)
            return { title: '', artist: '', ...readWav(bytes) };
        if (format === 2)
            return { title: '', artist: '', ...readFlac(bytes) };
        if (format === 3)
            return { title: '', artist: '', ...readMp3(bytes) };
    } catch (e) {
        // Ignore malformed tags; the filename is still shown.
    }
    return { title: '', artist: '' };
}
