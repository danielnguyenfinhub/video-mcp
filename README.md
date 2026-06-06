# 🎬 Video MCP — Local Video Editing for Claude Desktop

A local MCP server that gives Claude Desktop full video editing capabilities via FFmpeg, Whisper, and yt-dlp.

## Tools (15)

| Tool | Description |
|------|-------------|
| `inspect_video` | Get duration, resolution, FPS, codecs, file size |
| `trim_clip` | Cut start/end timestamps |
| `merge_clips` | Join multiple clips in sequence |
| `export_for_platform` | Reformat for YouTube / Reels / TikTok / LinkedIn / Shorts |
| `generate_thumbnail` | Extract a frame as JPG |
| `add_captions` | Auto-transcribe with Whisper + burn subtitles |
| `add_text_overlay` | Burn title/lower-third/outro text |
| `add_background_music` | Mix music with voice audio |
| `download_video` | Download from YouTube, TikTok, Instagram |
| `compress_video` | Reduce file size (high/medium/low) |
| `convert_format` | MP4 ↔ MOV ↔ WebM ↔ GIF ↔ MKV |
| `extract_audio` | Pull audio as MP3/WAV/AAC |
| `list_video_files` | Browse your video folder with metadata |
| `speed_change` | Slow-mo or speed ramp (0.5x, 2x, etc.) |
| `mute_section` | Silence audio between two timestamps |

## Prerequisites (Windows)

```cmd
winget install Gyan.FFmpeg
winget install yt-dlp.yt-dlp
winget install Python.Python.3.12
pip install openai-whisper
winget install OpenJS.NodeJS.LTS
```

## Setup

```cmd
git clone https://github.com/danielnguyenfinhub/video-mcp
cd video-mcp
npm install
npm run build
```

## Claude Desktop Config

Open: `%APPDATA%\Claude\claude_desktop_config.json`

Add to `mcpServers`:

```json
{
  "mcpServers": {
    "video-mcp": {
      "command": "node",
      "args": ["C:\\Users\\Daniel\\video-mcp\\dist\\index.js"],
      "env": {
        "VIDEO_DIR": "C:\\Users\\Daniel\\Videos",
        "OUTPUT_DIR": "C:\\Users\\Daniel\\Videos\\Output"
      }
    }
  }
}
```

Replace `Daniel` with your actual Windows username. Restart Claude Desktop.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VIDEO_DIR` | `%USERPROFILE%\Videos` | Where your source videos live |
| `OUTPUT_DIR` | `%USERPROFILE%\Videos\Output` | Where processed videos are saved |
| `FFMPEG_PATH` | `ffmpeg` | Custom FFmpeg path if not in PATH |
| `FFPROBE_PATH` | `ffprobe` | Custom ffprobe path |
| `YTDLP_PATH` | `yt-dlp` | Custom yt-dlp path |
| `WHISPER_PATH` | `whisper` | Custom Whisper path |
