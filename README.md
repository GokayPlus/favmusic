[Vencord Plugin](https://docs.vencord.dev/installing/custom-plugins/)

# FavMusic

Show your favorite music on your Discord profile — powered by iTunes.

## Features

- Adds a **Music List** tab to user profiles.
- Search and add songs from iTunes with album art and **30-second audio previews**.
- Click ▶ on any card to play a preview, click on the card to open the Apple Music page.
- Sync your list to a server so other users can see it on your profile.

## Usage

1. Enable the **FavMusic** plugin in Vencord settings.
2. Open your own profile and click the **Music List** tab.
3. Use the **Add** button to search for songs, artists, or albums.
4. Your list syncs automatically. Use **Sync Now** in settings for manual sync.

## API Disclaimer

This plugin uses the following external APIs:

- **[iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/)** — Apple's public API used to search for songs and retrieve metadata (title, artist, album art, preview URL). No authentication is required.
- **Custom sync server** — A self-hosted server used to store and retrieve users' favorite music lists by Discord user ID. No personal data beyond your Discord user ID and selected track metadata is transmitted.
