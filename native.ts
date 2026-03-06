/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2025 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { IpcMainInvokeEvent } from "electron";

const MUSIC_API_BASE = "https://api.anachter.dev/api/favmusic";
const ITUNES_API = "https://itunes.apple.com";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

function isValidSnowflake(id: string): boolean {
    return /^\d{17,20}$/.test(id);
}

// ==================== Music Server Sync ====================

export async function syncMusicList(
    _: IpcMainInvokeEvent,
    userId: string,
    token: string,
    favorites: any[],
): Promise<{ success: boolean; error?: string; }> {
    if (!isValidSnowflake(userId)) return { success: false, error: "Invalid userId" };
    try {
        const res = await fetch(`${MUSIC_API_BASE}/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, token, favorites }),
        });
        if (res.ok) return { success: true };
        try {
            const data = await res.json();
            return { success: false, error: data.error ?? `HTTP ${res.status}` };
        } catch {
            return { success: false, error: `HTTP ${res.status}` };
        }
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

/** Reconstruct full MusicData shape from flat server entry */
function reconstructMusic(a: any): any {
    if (!a || typeof a !== "object") return null;
    if (!Number.isInteger(a.id) || a.id <= 0) return null;
    if (typeof a.title !== "string" || !a.title) return null;
    return {
        id: a.id,
        title: a.title,
        artist_name: typeof a.artist_name === "string" ? a.artist_name : "",
        album_title: typeof a.album_title === "string" ? a.album_title : "",
        cover_small: typeof a.cover_small === "string" ? a.cover_small : "",
        cover_medium: typeof a.cover_medium === "string" ? a.cover_medium : "",
        cover_big: typeof a.cover_big === "string" ? a.cover_big : "",
        preview_url: typeof a.preview_url === "string" ? a.preview_url : "",
        duration: typeof a.duration === "number" ? a.duration : 0,
        link: typeof a.link === "string" ? a.link : "",
    };
}

export async function fetchMusicList(
    _: IpcMainInvokeEvent,
    userId: string
): Promise<{ favorites: any[]; }> {
    if (!isValidSnowflake(userId)) return { favorites: [] };
    try {
        const res = await fetch(`${MUSIC_API_BASE}/${encodeURIComponent(userId)}`);
        if (!res.ok) return { favorites: [] };
        const cl = res.headers.get("content-length");
        if (cl && parseInt(cl, 10) > MAX_RESPONSE_BYTES) return { favorites: [] };
        const text = await res.text();
        if (text.length > MAX_RESPONSE_BYTES) return { favorites: [] };
        const data = JSON.parse(text);
        return {
            favorites: (data.favorites ?? []).map(reconstructMusic).filter(Boolean),
        };
    } catch {
        return { favorites: [] };
    }
}

// ==================== iTunes Search API ====================

export async function searchMusic(
    _: IpcMainInvokeEvent,
    query: string
): Promise<any[]> {
    if (!query.trim()) return [];
    if (query.length > 200) return [];
    try {
        const res = await fetch(
            `${ITUNES_API}/search?term=${encodeURIComponent(query)}&media=music&limit=15&entity=song`
        );
        if (!res.ok) return [];
        const cl = res.headers.get("content-length");
        if (cl && parseInt(cl, 10) > MAX_RESPONSE_BYTES) return [];
        const text = await res.text();
        if (text.length > MAX_RESPONSE_BYTES) return [];
        const json = JSON.parse(text);
        return (json.results ?? []).map((t: any) => ({
            id: t.trackId,
            title: t.trackName ?? "",
            artist_name: t.artistName ?? "",
            album_title: t.collectionName ?? "",
            cover_small: (t.artworkUrl100 ?? "").replace("100x100", "60x60"),
            cover_medium: t.artworkUrl100 ?? "",
            cover_big: (t.artworkUrl100 ?? "").replace("100x100", "500x500"),
            preview_url: t.previewUrl ?? "",
            duration: Math.round((t.trackTimeMillis ?? 0) / 1000),
            link: t.trackViewUrl ?? "",
        }));
    } catch {
        return [];
    }
}

// ==================== Image Proxy ====================

const ALLOWED_IMAGE_HOSTS = [
    "https://is1-ssl.mzstatic.com/",
    "https://is2-ssl.mzstatic.com/",
    "https://is3-ssl.mzstatic.com/",
    "https://is4-ssl.mzstatic.com/",
    "https://is5-ssl.mzstatic.com/",
];

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

function isAllowedImageUrl(url: string): boolean {
    return ALLOWED_IMAGE_HOSTS.some(host => url.startsWith(host));
}

export async function fetchImage(
    _: IpcMainInvokeEvent,
    url: string
): Promise<string> {
    if (typeof url !== "string" || !isAllowedImageUrl(url)) return "";
    try {
        const res = await fetch(url, {
            redirect: "follow",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            }
        });
        if (!res.ok) return "";
        if (!isAllowedImageUrl(res.url)) return "";
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) return "";
        const contentLength = res.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) return "";
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) return "";
        const buffer = Buffer.from(arrayBuffer);
        return `data:${contentType};base64,${buffer.toString("base64")}`;
    } catch {
        return "";
    }
}

// ==================== Audio Proxy ====================

const ALLOWED_AUDIO_HOSTS = [
    "https://audio-ssl.itunes.apple.com/",
];

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB

function isAllowedAudioUrl(url: string): boolean {
    return ALLOWED_AUDIO_HOSTS.some(host => url.startsWith(host));
}

export async function fetchAudio(
    _: IpcMainInvokeEvent,
    url: string
): Promise<string> {
    if (typeof url !== "string" || !isAllowedAudioUrl(url)) return "";
    try {
        const res = await fetch(url, {
            redirect: "follow",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Accept": "audio/*,*/*;q=0.8",
            }
        });
        if (!res.ok) return "";
        if (!isAllowedAudioUrl(res.url)) return "";
        const contentType = res.headers.get("content-type") || "audio/mpeg";
        const contentLength = res.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > MAX_AUDIO_BYTES) return "";
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_AUDIO_BYTES) return "";
        const buffer = Buffer.from(arrayBuffer);
        return `data:${contentType};base64,${buffer.toString("base64")}`;
    } catch {
        return "";
    }
}
