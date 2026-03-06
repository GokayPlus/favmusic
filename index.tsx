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

import "./style.css";

import { get as DataStoreGet, set as DataStoreSet } from "@api/DataStore";
import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { PluginNative } from "@utils/types";
import { User } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { Button, Forms, React, ScrollerThin, Text, TextInput, Toasts, useCallback, useEffect, UserStore, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.FavMusic as PluginNative<typeof import("./native")>;

const ProfileListClasses = findCssClassesLazy("empty", "textContainer", "connectionIcon");
const TabBarClasses = findCssClassesLazy("tabPanelScroller", "tabBarPanel");

// ==================== Constants ====================

const STORE_KEY_MUSIC = "FavMusic_favorites";
const STORE_KEY_MUSIC_TOKEN = "FavMusic_syncToken";
const logger = new Logger("FavMusic");

// ==================== Types ====================

interface MusicData {
    id: number;
    title: string;
    artist_name: string;
    album_title: string;
    cover_small: string;
    cover_medium: string;
    cover_big: string;
    preview_url: string;
    duration: number;
    link: string;
}

// ==================== Music Data Layer ====================

let cachedMusic: MusicData[] = [];

function slimMusic(m: MusicData): MusicData {
    return {
        id: m.id,
        title: m.title,
        artist_name: m.artist_name,
        album_title: m.album_title,
        cover_small: m.cover_small,
        cover_medium: m.cover_medium,
        cover_big: m.cover_big,
        preview_url: m.preview_url,
        duration: m.duration,
        link: m.link,
    };
}

async function loadMusic(): Promise<MusicData[]> {
    try {
        const data = await DataStoreGet(STORE_KEY_MUSIC) as MusicData[] | undefined;
        cachedMusic = data ?? [];
    } catch (e) {
        logger.error("Failed to load music:", e);
        cachedMusic = [];
    }
    return cachedMusic;
}

async function addMusic(music: MusicData) {
    if (cachedMusic.some(m => m.id === music.id)) return;
    cachedMusic = [...cachedMusic, music];
    await DataStoreSet(STORE_KEY_MUSIC, cachedMusic);
    scheduleMusicSync();
}

async function removeMusic(id: number) {
    cachedMusic = cachedMusic.filter(m => m.id !== id);
    await DataStoreSet(STORE_KEY_MUSIC, cachedMusic);
    scheduleMusicSync();
}

// ==================== Remote Cache ====================

const REMOTE_CACHE_MAX = 200;
const REMOTE_CACHE_TTL = 120_000; // 2 minutes

const remoteMusicCache = new Map<string, { music: MusicData[]; fetchedAt: number; }>();
function remoteMusicCacheSet(userId: string, value: { music: MusicData[]; fetchedAt: number; }) {
    if (remoteMusicCache.size >= REMOTE_CACHE_MAX) remoteMusicCache.delete(remoteMusicCache.keys().next().value!);
    remoteMusicCache.set(userId, value);
}

// ==================== Music Server Sync ====================

let musicSyncToken: string | null = null;
let musicSyncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleMusicSync() {
    if (musicSyncTimer) clearTimeout(musicSyncTimer);
    musicSyncTimer = setTimeout(() => { musicSyncTimer = null; syncMusicToServer().catch(() => { }); }, 2000);
}

async function loadMusicSyncToken(): Promise<string> {
    if (musicSyncToken) return musicSyncToken;
    let token = await DataStoreGet(STORE_KEY_MUSIC_TOKEN) as string | undefined;
    if (!token) {
        const arr = new Uint8Array(24);
        crypto.getRandomValues(arr);
        token = Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
        await DataStoreSet(STORE_KEY_MUSIC_TOKEN, token);
    }
    musicSyncToken = token;
    return token;
}

async function syncMusicToServer(): Promise<boolean> {
    try {
        const token = await loadMusicSyncToken();
        const userId = UserStore.getCurrentUser()?.id;
        if (!userId) return false;
        const result = await Native.syncMusicList(userId, token, cachedMusic.map(slimMusic));
        if (!result.success) { logger.error("Music sync failed:", result.error); return false; }
        return true;
    } catch (e) { logger.error("Music sync exception:", e); return false; }
}

async function fetchRemoteMusicList(userId: string): Promise<{ music: MusicData[]; } | null> {
    const cached = remoteMusicCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < REMOTE_CACHE_TTL) return cached;
    try {
        const data = await Native.fetchMusicList(userId);
        const music: MusicData[] = data.favorites ?? [];
        if (music.length === 0) return null;
        const result = { music, fetchedAt: Date.now() };
        remoteMusicCacheSet(userId, result);
        return result;
    } catch (e) { logger.error(`Failed to fetch remote music for ${userId}:`, e); return null; }
}

// ==================== Search ====================

async function searchMusicItunes(query: string): Promise<MusicData[]> {
    if (!query.trim()) return [];
    try {
        return (await Native.searchMusic(query) ?? []) as MusicData[];
    } catch (e) { logger.error("Music search failed:", e); return []; }
}

// ==================== Helpers ====================

function useDebounce<T>(value: T, delay: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);
    return debounced;
}

function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// ==================== Audio Player ====================

let globalAudio: HTMLAudioElement | null = null;
let globalPlayingId: number | null = null;
const audioListeners = new Set<() => void>();

function notifyAudioListeners() { audioListeners.forEach(fn => fn()); }

const AUDIO_BLOB_CACHE_MAX = 50;
const audioBlobCache = new Map<string, string>();

async function fetchAudioBlob(previewUrl: string): Promise<string> {
    const cached = audioBlobCache.get(previewUrl);
    if (cached) return cached;
    try {
        const dataUri = await Native.fetchAudio(previewUrl);
        if (!dataUri) return "";
        const [header, b64] = dataUri.split(",", 2);
        const mime = header.split(":")[1]?.split(";")[0] || "audio/mpeg";
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime });
        const blobUrl = URL.createObjectURL(blob);
        if (audioBlobCache.size >= AUDIO_BLOB_CACHE_MAX) {
            const oldest = audioBlobCache.keys().next().value!;
            URL.revokeObjectURL(audioBlobCache.get(oldest)!);
            audioBlobCache.delete(oldest);
        }
        audioBlobCache.set(previewUrl, blobUrl);
        return blobUrl;
    } catch {
        return "";
    }
}

function togglePreview(previewUrl: string, trackId: number) {
    if (globalAudio) {
        const wasSameTrack = globalPlayingId === trackId;
        globalAudio.pause();
        globalAudio.src = "";
        globalAudio = null;
        globalPlayingId = null;
        notifyAudioListeners();
        if (wasSameTrack) return;
    }
    globalPlayingId = trackId;
    notifyAudioListeners();
    fetchAudioBlob(previewUrl).then(blobUrl => {
        if (globalPlayingId !== trackId) return;
        if (!blobUrl) { globalPlayingId = null; notifyAudioListeners(); return; }
        const audio = new Audio(blobUrl);
        globalAudio = audio;
        audio.volume = 0.5;
        audio.play().catch(() => { globalAudio = null; globalPlayingId = null; notifyAudioListeners(); });
        audio.addEventListener("ended", () => { globalAudio = null; globalPlayingId = null; notifyAudioListeners(); });
        notifyAudioListeners();
    });
}

function stopAllAudio() {
    if (globalAudio) { globalAudio.pause(); globalAudio.src = ""; globalAudio = null; globalPlayingId = null; notifyAudioListeners(); }
}

function useAudioPlaying(trackId: number): boolean {
    const [playing, setPlaying] = useState(globalPlayingId === trackId);
    useEffect(() => {
        const listener = () => setPlaying(globalPlayingId === trackId);
        audioListeners.add(listener);
        return () => { audioListeners.delete(listener); };
    }, [trackId]);
    return playing;
}

// ==================== Components ====================

const IMAGE_CACHE_MAX = 150;
const imageCache = new Map<string, string>();
function imageCacheSet(key: string, value: string) {
    if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value!);
    imageCache.set(key, value);
}

const imageInflight = new Map<string, Promise<string>>();

function ProxiedImage({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
    const [dataUrl, setDataUrl] = useState<string>(imageCache.get(src ?? "") ?? "");
    useEffect(() => {
        if (!src) return;
        const cached = imageCache.get(src);
        if (cached) { setDataUrl(cached); return; }
        let promise = imageInflight.get(src);
        if (!promise) {
            promise = Native.fetchImage(src).catch(() => "");
            imageInflight.set(src, promise);
            promise.finally(() => imageInflight.delete(src));
        }
        let cancelled = false;
        promise.then(result => { if (!cancelled && result) { imageCacheSet(src, result); setDataUrl(result); } });
        return () => { cancelled = true; };
    }, [src]);
    if (!dataUrl) return <div style={{ width: "100%", height: "100%", background: "var(--background-secondary)" }} />;
    return <img src={dataUrl} alt={alt} {...props} />;
}

function MusicCard({ music, onAdd, onRemove, added, compact }: {
    music: MusicData;
    onAdd?: () => void;
    onRemove?: () => void;
    added?: boolean;
    compact?: boolean;
}) {
    const playing = useAudioPlaying(music.id);
    const imgUrl = compact ? music.cover_medium : (music.cover_big || music.cover_medium);
    return (
        <div className={`vc-favmusic-card${compact ? " vc-favmusic-card-compact" : ""}`}
            onClick={() => window.open(music.link, "_blank", "noopener,noreferrer")}>
            <div className="vc-favmusic-card-poster">
                <ProxiedImage src={imgUrl} alt={music.title} loading="eager" />
                {music.preview_url && (
                    <button className={`vc-favmusic-btn-play${playing ? " vc-favmusic-btn-playing" : ""}`}
                        onClick={e => { e.stopPropagation(); togglePreview(music.preview_url, music.id); }}
                        title={playing ? "Stop preview" : "Play 30s preview"}>
                        {playing ? "⏸" : "▶"}
                    </button>
                )}
                {onRemove && (
                    <button className="vc-favmusic-btn-remove"
                        onClick={e => { e.stopPropagation(); onRemove(); }} title="Remove">✕</button>
                )}
                {onAdd && (
                    <button className={`vc-favmusic-btn-add${added ? " vc-favmusic-btn-added" : ""}`}
                        onClick={e => { e.stopPropagation(); if (!added) onAdd(); }}
                        title={added ? "Already added" : "Add to favorites"}>
                        {added ? "✓" : "+"}
                    </button>
                )}
            </div>
            <div className="vc-favmusic-card-info">
                <span className="vc-favmusic-card-title" title={music.title}>{music.title}</span>
                <span className="vc-favmusic-card-meta">
                    {music.artist_name}{music.duration ? ` · ${formatDuration(music.duration)}` : ""}
                </span>
            </div>
        </div>
    );
}

// ==================== Music Search Modal ====================

function MusicSearchModal({ rootProps, onChanged }: { rootProps: any; onChanged: () => void; }) {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<MusicData[]>([]);
    const [loading, setLoading] = useState(false);
    const [addedIds, setAddedIds] = useState<Set<number>>(new Set(cachedMusic.map(m => m.id)));
    const debouncedQuery = useDebounce(query, 400);

    useEffect(() => {
        if (!debouncedQuery.trim()) { setResults([]); return; }
        let cancelled = false;
        setLoading(true);
        searchMusicItunes(debouncedQuery).then(data => { if (!cancelled) { setResults(data); setLoading(false); } });
        return () => { cancelled = true; };
    }, [debouncedQuery]);

    useEffect(() => () => stopAllAudio(), []);

    const handleAdd = useCallback(async (music: MusicData) => {
        await addMusic(music);
        setAddedIds(new Set(cachedMusic.map(m => m.id)));
        onChanged();
    }, [onChanged]);

    return (
        <ModalRoot {...rootProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>🎵 Search Music — iTunes</Text>
                <ModalCloseButton onClick={rootProps.onClose} />
            </ModalHeader>
            <ModalContent>
                <div className="vc-favmusic-search-container">
                    <TextInput placeholder="Search for songs, artists, or albums..." value={query} onChange={setQuery} autoFocus />
                    {loading && (
                        <div className="vc-favmusic-loading">
                            <div className="vc-favmusic-spinner" />
                            <Text variant="text-md/medium">Searching...</Text>
                        </div>
                    )}
                    {!loading && results.length === 0 && debouncedQuery.trim() && (
                        <div className="vc-favmusic-empty">
                            <Text variant="text-md/medium">No results for &quot;{debouncedQuery}&quot;</Text>
                        </div>
                    )}
                    {!loading && !debouncedQuery.trim() && (
                        <div className="vc-favmusic-empty">
                            <div className="vc-favmusic-empty-icon">🔍</div>
                            <Text variant="text-md/medium" style={{ color: "var(--text-muted)" }}>
                                Type above to find your favorite music
                            </Text>
                        </div>
                    )}
                    {!loading && results.length > 0 && (
                        <div className="vc-favmusic-search-grid">
                            {results.map(music => (
                                <MusicCard key={music.id} music={music} onAdd={() => handleAdd(music)} added={addedIds.has(music.id)} />
                            ))}
                        </div>
                    )}
                </div>
            </ModalContent>
        </ModalRoot>
    );
}

function openMusicSearchModal(onChanged: () => void) {
    openModal(props => <MusicSearchModal rootProps={props} onChanged={onChanged} />);
}

// ==================== Board Content ====================

function MusicBoardContent({ user, isCurrentUser }: { user: User; isCurrentUser: boolean; }) {
    const [musicList, setMusicList] = useState<MusicData[]>(isCurrentUser ? cachedMusic : []);
    const [loading, setLoading] = useState(!isCurrentUser);

    useEffect(() => {
        if (isCurrentUser) {
            loadMusic().then(setMusicList);
        } else {
            setLoading(true);
            fetchRemoteMusicList(user.id).then(data => {
                if (data) setMusicList(data.music);
                setLoading(false);
            });
        }
        return () => stopAllAudio();
    }, [user.id]);

    const handleRemove = useCallback(async (id: number) => {
        await removeMusic(id);
        setMusicList([...cachedMusic]);
    }, []);

    const handleAdd = useCallback(() => {
        openMusicSearchModal(() => loadMusic().then(setMusicList));
    }, []);

    if (loading) {
        return (
            <div className="vc-favmusic-board-content">
                <div className="vc-favmusic-loading">
                    <div className="vc-favmusic-spinner" />
                    <Text variant="text-md/medium">Loading music list...</Text>
                </div>
            </div>
        );
    }

    return (
        <div className="vc-favmusic-board-content">
            <div className="vc-favmusic-board-header">
                <Text variant="text-xs/semibold" style={{ color: "var(--header-secondary)", textTransform: "uppercase", letterSpacing: "0.02em" }}>
                    🎵 ({musicList.length})
                </Text>
                {isCurrentUser && (
                    <Button size={Button.Sizes.MIN} color={Button.Colors.PRIMARY} onClick={handleAdd}>Add</Button>
                )}
            </div>
            {musicList.length > 0 ? (
                <div className="vc-favmusic-board-grid">
                    {musicList.map(music => (
                        <MusicCard key={music.id} music={music}
                            onRemove={isCurrentUser ? () => handleRemove(music.id) : undefined} compact />
                    ))}
                </div>
            ) : (
                <div className={ProfileListClasses.empty} style={{ padding: "16px 0" }}>
                    <div className={ProfileListClasses.textContainer}>
                        <BaseText tag="h3" size="md" weight="medium" style={{ color: "var(--text-strong)" }}>
                            {isCurrentUser ? "No music added yet. Use the Add button!" : "No favorite music."}
                        </BaseText>
                    </div>
                </div>
            )}
        </div>
    );
}

// ==================== Settings Panel ====================

function MusicListSection({ list, onRefresh }: { list: MusicData[]; onRefresh: () => void; }) {
    const handleRemove = useCallback(async (id: number) => { await removeMusic(id); onRefresh(); }, [onRefresh]);
    return (
        <Forms.FormSection>
            <Forms.FormTitle tag="h3">🎵 Your Favorite Music</Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 12 }}>
                Search and add music from iTunes — shown on your profile's MusicBoard.
            </Forms.FormText>
            <Button onClick={() => openMusicSearchModal(onRefresh)} size={Button.Sizes.SMALL} color={Button.Colors.BRAND}>
                🎵 Add Music
            </Button>
            {list.length > 0 ? (
                <div className="vc-favmusic-settings-grid">
                    {list.map(music => <MusicCard key={music.id} music={music} onRemove={() => handleRemove(music.id)} />)}
                </div>
            ) : (
                <div className="vc-favmusic-settings-empty">
                    <div className="vc-favmusic-empty-icon">🎵</div>
                    <Text variant="text-md/medium" style={{ color: "var(--text-muted)" }}>No music added yet. Use the button above to get started!</Text>
                </div>
            )}
        </Forms.FormSection>
    );
}

function CloudSyncStatus() {
    const [syncing, setSyncing] = useState(false);
    const [lastResult, setLastResult] = useState<string>("");

    const handleSync = useCallback(async () => {
        if (cachedMusic.length === 0) {
            Toasts.show({ type: Toasts.Type.FAILURE, message: "No data to sync!", id: Toasts.genId() });
            return;
        }
        setSyncing(true);
        setLastResult("");
        const ok = await syncMusicToServer();
        setSyncing(false);
        if (ok) {
            setLastResult("Synced successfully! Other FavMusic users can now see your list.");
            Toasts.show({ type: Toasts.Type.SUCCESS, message: "Music list synced!", id: Toasts.genId() });
        } else {
            setLastResult("Sync failed. Please try again later.");
            Toasts.show({ type: Toasts.Type.FAILURE, message: "Sync failed!", id: Toasts.genId() });
        }
    }, []);

    return (
        <div className="vc-favmusic-import-section">
            <Forms.FormTitle tag="h3">☁️ Sync to Server</Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 8 }}>
                If you have problems with automatic sync, you can sync your music list manually so other users can see it on your profile.
            </Forms.FormText>
            <Button onClick={handleSync} size={Button.Sizes.SMALL} color={Button.Colors.BRAND} disabled={syncing}>
                {syncing ? "Syncing..." : "Sync Now"}
            </Button>
            {lastResult && (
                <Text variant="text-sm/medium" style={{ marginTop: 8, color: "var(--text-muted)" }}>{lastResult}</Text>
            )}
        </div>
    );
}

function SettingsPanel() {
    const [musicList, setMusicList] = useState<MusicData[]>(cachedMusic);

    const refreshAll = useCallback(() => {
        loadMusic().then(m => setMusicList([...m]));
    }, []);

    useEffect(() => { refreshAll(); }, []);

    return (
        <div className="vc-favmusic-settings">
            <MusicListSection list={musicList} onRefresh={refreshAll} />
            <div style={{ marginTop: 20 }}>
                <CloudSyncStatus />
            </div>
        </div>
    );
}

// ==================== Plugin Definition ====================

const IS_PATCHED = Symbol("FavMusic.Patched");

export default definePlugin({
    name: "FavMusic",
    description: "FavMusic — Add a MusicBoard tab to user profiles showing favorite music. Powered by iTunes.",
    authors: [{ name: "canplus", id: 852614422235971655n }],

    settingsAboutComponent: () => <SettingsPanel />,

    async start() {
        await loadMusic();
    },

    stop() {
        stopAllAudio();
    },

    patches: [
        // User Profile Modal (v1)
        {
            find: ".BOT_DATA_ACCESS?(",
            replacement: [
                {
                    match: /\i\.useEffect.{0,100}(\i)\[0\]\.section/,
                    replace: "$self.pushSection($1,arguments[0].user);$&"
                },
                {
                    match: /\(0,\i\.jsx\)\(\i,\{items:\i,section:(\i)/,
                    replace: "$1==='FAV_MUSIC'?$self.renderMusicBoard(arguments[0]):$&"
                },
            ]
        },
        // User Profile Modal v2
        {
            find: ".WIDGETS?",
            replacement: [
                {
                    match: /items:(\i),.+?(?=return\(0,\i\.jsxs?\)\("div)/,
                    replace: "$&$self.pushSection($1,arguments[0].user);"
                },
                {
                    match: /\(0,\i\.jsxs?\)\(\i,\{.{0,200}?section:(\i)/,
                    replace: "$1==='FAV_MUSIC'?$self.renderMusicBoard(arguments[0]):$&"
                },
            ]
        },
    ],

    pushSection(sections: any[], _user: User) {
        try {
            if (sections[IS_PATCHED]) return;
            sections[IS_PATCHED] = true;
            sections.splice(1, 0, { text: "MusicBoard", section: "FAV_MUSIC" });
        } catch (e) {
            logger.error("Failed to push FavMusic section:", e);
        }
    },

    renderMusicBoard: ErrorBoundary.wrap(({ user, onClose }: { user: User; onClose: () => void; }) => {
        const currentUser = UserStore.getCurrentUser();
        const isCurrentUser = !!currentUser && !!user && user.id === currentUser.id;

        return (
            <ScrollerThin className={TabBarClasses.tabPanelScroller} fade={true} onClose={onClose}>
                <MusicBoardContent user={user} isCurrentUser={isCurrentUser} />
            </ScrollerThin>
        );
    }),
});

// im just saying token for id, not discord token
