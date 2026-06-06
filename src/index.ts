import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const execAsync = promisify(exec);

const VIDEO_DIR = process.env.VIDEO_DIR || path.join(os.homedir(), "Videos");
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(VIDEO_DIR, "Output");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const WHISPER = process.env.WHISPER_PATH || "whisper";

// Ensure output dir exists
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function resolvePath(filepath: string): string {
  if (path.isAbsolute(filepath)) return filepath;
  return path.join(VIDEO_DIR, filepath);
}

function outputPath(filename: string): string {
  return path.join(OUTPUT_DIR, filename);
}

// For FFmpeg subtitles filter — Windows needs escaped path
function escapeSrtPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

async function ffmpeg(args: string, timeoutMs = 600000): Promise<string> {
  const { stdout, stderr } = await execAsync(`"${FFMPEG}" ${args}`, { timeout: timeoutMs });
  return stderr || stdout;
}

async function ffprobe(filepath: string): Promise<any> {
  const { stdout } = await execAsync(
    `"${FFPROBE}" -v quiet -print_format json -show_format -show_streams "${filepath}"`
  );
  return JSON.parse(stdout);
}

const server = new McpServer({ name: "video-mcp", version: "1.0.0" });

// ─── 1. INSPECT VIDEO ──────────────────────────────────────────────────────────
server.tool(
  "inspect_video",
  "Get full metadata for a video file — duration, resolution, FPS, codecs, file size, audio tracks.",
  { filepath: z.string().describe("Full path or filename relative to VIDEO_DIR") },
  async ({ filepath }) => {
    try {
      const full = resolvePath(filepath);
      const info = await ffprobe(full);
      const fmt = info.format;
      const vStream = info.streams?.find((s: any) => s.codec_type === "video");
      const aStream = info.streams?.find((s: any) => s.codec_type === "audio");
      const duration = parseFloat(fmt.duration || "0");
      const mins = Math.floor(duration / 60);
      const secs = (duration % 60).toFixed(1);
      const sizeMB = (parseInt(fmt.size || "0") / 1024 / 1024).toFixed(2);

      return {
        content: [{
          type: "text", text: [
            `📹 File: ${path.basename(full)}`,
            `⏱️  Duration: ${mins}m ${secs}s`,
            `📐 Resolution: ${vStream?.width}x${vStream?.height}`,
            `🎞️  FPS: ${(vStream?.r_frame_rate ? Function('"use strict";return (' + vStream.r_frame_rate + ')')() : 0).toFixed(2)}`,
            `🎬 Video codec: ${vStream?.codec_name?.toUpperCase()}`,
            `🔊 Audio codec: ${aStream?.codec_name?.toUpperCase() || "None"}`,
            `💾 File size: ${sizeMB} MB`,
            `📁 Path: ${full}`,
          ].join("\n")
        }]
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 2. TRIM CLIP ──────────────────────────────────────────────────────────────
server.tool(
  "trim_clip",
  "Cut a video between two timestamps. Fast copy mode — no re-encoding.",
  {
    filepath: z.string().describe("Input video path or filename"),
    start: z.string().describe("Start time e.g. 00:01:30 or 90"),
    end: z.string().describe("End time e.g. 00:04:00 or 240"),
    output: z.string().optional().describe("Output filename (optional, auto-named if omitted)"),
  },
  async ({ filepath, start, end, output }) => {
    try {
      const input = resolvePath(filepath);
      const outName = output || `trimmed_${Date.now()}${path.extname(filepath)}`;
      const out = outputPath(outName);
      await ffmpeg(`-i "${input}" -ss ${start} -to ${end} -c copy "${out}"`);
      return { content: [{ type: "text", text: `✅ Trimmed: ${start} → ${end}\n📁 Saved: ${out}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 3. MERGE CLIPS ────────────────────────────────────────────────────────────
server.tool(
  "merge_clips",
  "Join multiple video clips together in sequence. All clips must have the same resolution and codec.",
  {
    clips: z.array(z.string()).describe("Array of video filenames or paths in order"),
    output: z.string().optional().describe("Output filename (optional)"),
  },
  async ({ clips, output }) => {
    try {
      const listPath = path.join(os.tmpdir(), `concat_${Date.now()}.txt`);
      const lines = clips.map(c => `file '${resolvePath(c).replace(/'/g, "'\\''")}'`).join("\n");
      fs.writeFileSync(listPath, lines, "utf8");
      const outName = output || `merged_${Date.now()}.mp4`;
      const out = outputPath(outName);
      await ffmpeg(`-f concat -safe 0 -i "${listPath}" -c copy "${out}"`);
      fs.unlinkSync(listPath);
      return { content: [{ type: "text", text: `✅ Merged ${clips.length} clips\n📁 Saved: ${out}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 4. EXPORT FOR PLATFORM ────────────────────────────────────────────────────
server.tool(
  "export_for_platform",
  "Re-encode video for a specific platform with correct resolution and format. Platforms: youtube, reels, tiktok, linkedin, shorts",
  {
    filepath: z.string().describe("Input video"),
    platform: z.enum(["youtube", "reels", "tiktok", "linkedin", "shorts"]),
    output: z.string().optional().describe("Output filename (optional)"),
  },
  async ({ filepath, platform, output }) => {
    try {
      const input = resolvePath(filepath);
      const profiles: Record<string, { w: number; h: number; label: string }> = {
        youtube:  { w: 1920, h: 1080, label: "YouTube 1080p 16:9" },
        linkedin: { w: 1280, h: 720,  label: "LinkedIn 720p 16:9" },
        reels:    { w: 1080, h: 1920, label: "Instagram Reels 9:16" },
        tiktok:   { w: 1080, h: 1920, label: "TikTok 9:16" },
        shorts:   { w: 1080, h: 1920, label: "YouTube Shorts 9:16" },
      };
      const p = profiles[platform];
      const outName = output || `${platform}_${Date.now()}.mp4`;
      const out = outputPath(outName);
      const vf = `scale=${p.w}:${p.h}:force_original_aspect_ratio=decrease,pad=${p.w}:${p.h}:(ow-iw)/2:(oh-ih)/2:black`;
      await ffmpeg(`-i "${input}" -vf "${vf}" -c:v libx264 -crf 23 -preset fast -c:a aac -b:a 192k "${out}"`, 900000);
      return { content: [{ type: "text", text: `✅ Exported for ${p.label}\n📁 Saved: ${out}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 5. GENERATE THUMBNAIL ─────────────────────────────────────────────────────
server.tool(
  "generate_thumbnail",
  "Extract a single frame from a video as a JPG thumbnail.",
  {
    filepath: z.string().describe("Input video"),
    timestamp: z.string().describe("Timestamp to grab e.g. 00:00:05 or 5"),
    output: z.string().optional().describe("Output filename (default: thumbnail.jpg)"),
  },
  async ({ filepath, timestamp, output }) => {
    try {
      const input = resolvePath(filepath);
      const outName = output || `thumb_${Date.now()}.jpg`;
      const out = outputPath(outName);
      await ffmpeg(`-ss ${timestamp} -i "${input}" -frames:v 1 -q:v 2 "${out}"`);
      return { content: [{ type: "text", text: `✅ Thumbnail saved at ${timestamp}\n📁 Saved: ${out}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 6. ADD CAPTIONS (WHISPER) ─────────────────────────────────────────────────
server.tool(
  "add_captions",
  "Auto-transcribe a video with Whisper AI and burn subtitles into it. Takes a few minutes for longer videos.",
  {
    filepath: z.string().describe("Input video"),
    language: z.string().optional().describe("Language code e.g. en, vi (default: auto-detect)"),
    output: z.string().optional().describe("Output filename (optional)"),
  },
  async ({ filepath, language, output }) => {
    try {
      const input = resolvePath(filepath);
      const tmpDir = path.join(os.tmpdir(), `whisper_${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      // Run Whisper
      const langFlag = language ? `--language ${language}` : "";
      await execAsync(`"${WHISPER}" "${input}" --output_format srt --output_dir "${tmpDir}" ${langFlag}`, { timeout: 900000 });

      // Find the SRT file
      const srtFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith(".srt"));
      if (!srtFiles.length) throw new Error("Whisper did not produce an SRT file");
      const srtPath = path.join(tmpDir, srtFiles[0]);

      const outName = output || `captioned_${Date.now()}.mp4`;
      const out = outputPath(outName);
      const srtEscaped = escapeSrtPath(srtPath);
      await ffmpeg(`-i "${input}" -vf "subtitles='${srtEscaped}':force_style='FontSize=20,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2'" -c:a copy "${out}"`, 900000);

      // Save SRT alongside output
      const srtOut = out.replace(/\.[^/.]+$/, ".srt");
      fs.copyFileSync(srtPath, srtOut);

      return { content: [{ type: "text", text: `✅ Captions added\n📄 SRT saved: ${srtOut}\n📁 Video saved: ${out}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 7. ADD TEXT OVERLAY ───────────────────────────────────────────────────────
server.tool(
  "add_text_overlay",
  "Burn text onto a video (title card, lower third, outro). Position: top, center, bottom.",
  {
    filepath: z.string().describe("Input video"),
    text: z.string().describe("Text to display"),
    position: z.enum(["top", "center", "bottom"]).default("bottom"),
    fontsize: z.number().optional().default(48).describe("Font size in pixels"),
    color: z.string().optional().default("white").describe("Text colour e.g. white, yellow, #FF0000"),
    start_time: z.number().optional().describe("Show from this second (optional, shows whole video if omitted)"),
    end_time: z.number().optional().describe("Hide after this second (optional)"),
    output: z.string().optional().describe("Output filename"),
  },
  async ({ filepath, text, position, fontsize, color, start_time, end_time, output }) => {
    try {
      const input = resolvePath(filepath);
      const yMap: Record<string, string> = {
        top: "50",
        center: "(h-text_h)/2",
        bottom: "h-text_h-50",
      };
      const y = yMap[position];
      const escapedText = text.replace(/'/g, "\\'").replace(/:/g, "\\:");
      let timeExpr = "";
      if (start_time !== undefined && end_time !== undefined) {
        timeExpr = `:enable='between(t,${start_time},${end_time})'`;
      }
      const drawtext = `drawtext=text='${escapedText}':fontcolor=${color}:fontsize=${fontsize}:x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.5:boxborderw=8${timeExpr}`;
      const outName = output || `text_${Date.now()}.mp4`;
      const out = outputPath(outName);
      await ffmpeg(`-i "${input}" -vf "${drawtext}" -c:a copy "${out}"`, 900000);
      return { content: [{ type: "text", text: `✅ Text overlay added\n📁 Saved: ${out}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 8. ADD BACKGROUND MUSIC ───────────────────────────────────────────────────
server.tool(
  "add_background_music",
  "Mix background music into a video. Control the volume balance between voice and music.",
  {
    filepath: z.string().describe("Input video"),
    music: z.string().describe("Path or filename of music/audio file"),
    video_volume: z.number().optional().default(1.0).describe("Original audio volume 0.0-1.0 (default 1.0)"),
    music_volume: z.number().optional().default(0.2).describe("Music volume 0.0-1.0 (default 0.2)"),
    output: z.string().optional().describe("Output filename"),
  },
  async ({ filepath, music, video_volume, music_volume, output }) => {
    try {
      const input = resolvePath(filepath);
      const musicPath = resolvePath(music);
      const outName = output || `music_${Date.now()}.mp4`;
      const out = outputPath(outName);
      const filter = `[0:a]volume=${video_volume}[a1];[1:a]volume=${music_volume}[a2];[a1][a2]amix=inputs=2:duration=first:dropout_transition=2`;
      await ffmpeg(`-i "${input}" -i "${musicPath}" -filter_complex "${filter}" -c:v copy "${out}"`, 900000);
      return { content: [{ type: "text", text: `✅ Background music added (voice: ${video_volume * 100}% / music: ${music_volume * 100}%)\n📁 Saved: ${out}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 9. DOWNLOAD VIDEO ─────────────────────────────────────────────────────────
server.tool(
  "download_video",
  "Download a video from YouTube, TikTok, Instagram, Facebook, or any supported site.",
  {
    url: z.string().describe("Video URL"),
    quality: z.enum(["best", "1080p", "720p", "480p", "audio_only"]).optional().default("best"),
    output_dir: z.string().optional().describe("Save to this folder (default: VIDEO_DIR)"),
  },
  async ({ url, quality, output_dir }) => {
    try {
      const saveDir = output_dir || VIDEO_DIR;
      let formatFlag = "";
      if (quality === "audio_only") formatFlag = "-x --audio-format mp3";
      else if (quality === "1080p") formatFlag = `-f "bestvideo[height<=1080]+bestaudio/best[height<=1080]"`;
      else if (quality === "720p") formatFlag = `-f "bestvideo[height<=720]+bestaudio/best[height<=720]"`;
      else if (quality === "480p") formatFlag = `-f "bestvideo[height<=480]+bestaudio/best[height<=480]"`;

      const { stdout } = await execAsync(
        `"${YTDLP}" ${formatFlag} --merge-output-format mp4 -o "${saveDir}\\%(title)s.%(ext)s" "${url}"`,
        { timeout: 600000 }
      );
      const lines = stdout.split("\n").filter(l => l.includes("[download] Destination") || l.includes("[Merger]"));
      return { content: [{ type: "text", text: `✅ Download complete\n📁 Saved to: ${saveDir}\n${lines.join("\n")}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 10. COMPRESS VIDEO ────────────────────────────────────────────────────────
server.tool(
  "compress_video",
  "Reduce video file size. Quality: high (CRF 20), medium (CRF 28), low (CRF 35). Higher CRF = smaller file.",
  {
    filepath: z.string().describe("Input video"),
    quality: z.enum(["high", "medium", "low"]).default("medium"),
    output: z.string().optional().describe("Output filename"),
  },
  async ({ filepath, quality, output }) => {
    try {
      const input = resolvePath(filepath);
      const crfMap = { high: 20, medium: 28, low: 35 };
      const crf = crfMap[quality];
      const outName = output || `compressed_${quality}_${Date.now()}.mp4`;
      const out = outputPath(outName);
      await ffmpeg(`-i "${input}" -c:v libx264 -crf ${crf} -preset medium -c:a aac -b:a 128k "${out}"`, 900000);
      const origMB = (fs.statSync(input).size / 1024 / 1024).toFixed(2);
      const newMB = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
      const saving = (((parseFloat(origMB) - parseFloat(newMB)) / parseFloat(origMB)) * 100).toFixed(0);
      return { content: [{ type: "text", text: `✅ Compressed (${quality} quality)\n📊 ${origMB} MB → ${newMB} MB (${saving}% smaller)\n📁 Saved: ${out}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 11. CONVERT FORMAT ────────────────────────────────────────────────────────
server.tool(
  "convert_format",
  "Convert video to a different format. Formats: mp4, mov, avi, webm, gif, mkv",
  {
    filepath: z.string().describe("Input video"),
    format: z.enum(["mp4", "mov", "avi", "webm", "gif", "mkv"]),
    output: z.string().optional().describe("Output filename (optional)"),
  },
  async ({ filepath, format, output }) => {
    try {
      const input = resolvePath(filepath);
      const base = path.basename(input, path.extname(input));
      const outName = output || `${base}_${Date.now()}.${format}`;
      const out = outputPath(outName);
      let extraFlags = "";
      if (format === "gif") extraFlags = "-vf fps=15,scale=480:-1:flags=lanczos";
      await ffmpeg(`-i "${input}" ${extraFlags} "${out}"`, 900000);
      return { content: [{ type: "text", text: `✅ Converted to ${format.toUpperCase()}\n📁 Saved: ${out}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 12. EXTRACT AUDIO ─────────────────────────────────────────────────────────
server.tool(
  "extract_audio",
  "Pull the audio track out of a video as an MP3 or WAV file.",
  {
    filepath: z.string().describe("Input video"),
    format: z.enum(["mp3", "wav", "aac"]).default("mp3"),
    output: z.string().optional().describe("Output filename"),
  },
  async ({ filepath, format, output }) => {
    try {
      const input = resolvePath(filepath);
      const base = path.basename(input, path.extname(input));
      const outName = output || `${base}_audio_${Date.now()}.${format}`;
      const out = outputPath(outName);
      const codec = format === "mp3" ? "-c:a libmp3lame -q:a 2" : format === "wav" ? "-c:a pcm_s16le" : "-c:a aac -b:a 192k";
      await ffmpeg(`-i "${input}" -vn ${codec} "${out}"`);
      return { content: [{ type: "text", text: `✅ Audio extracted as ${format.toUpperCase()}\n📁 Saved: ${out}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 13. LIST VIDEO FILES ──────────────────────────────────────────────────────
server.tool(
  "list_video_files",
  "List all video files in your VIDEO_DIR (or a specified folder) with size and duration.",
  {
    folder: z.string().optional().describe("Subfolder name or full path (default: VIDEO_DIR)"),
  },
  async ({ folder }) => {
    try {
      const dir = folder ? resolvePath(folder) : VIDEO_DIR;
      const exts = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".flv"];
      const files = fs.readdirSync(dir).filter(f => exts.includes(path.extname(f).toLowerCase()));
      if (!files.length) return { content: [{ type: "text", text: `📂 No video files found in: ${dir}` }] };

      const lines = await Promise.all(files.map(async f => {
        const full = path.join(dir, f);
        const sizeMB = (fs.statSync(full).size / 1024 / 1024).toFixed(1);
        try {
          const info = await ffprobe(full);
          const dur = parseFloat(info.format?.duration || "0");
          const mins = Math.floor(dur / 60);
          const secs = Math.round(dur % 60);
          return `• ${f} — ${sizeMB} MB — ${mins}m ${secs}s`;
        } catch {
          return `• ${f} — ${sizeMB} MB`;
        }
      }));

      return { content: [{ type: "text", text: `📂 ${dir}\n\n${lines.join("\n")}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 14. SPEED CHANGE ─────────────────────────────────────────────────────────
server.tool(
  "speed_change",
  "Speed up or slow down a video. Speed: 0.5 = half speed, 2.0 = double speed, etc.",
  {
    filepath: z.string().describe("Input video"),
    speed: z.number().describe("Speed multiplier e.g. 0.5, 1.5, 2.0"),
    output: z.string().optional().describe("Output filename"),
  },
  async ({ filepath, speed, output }) => {
    try {
      const input = resolvePath(filepath);
      const outName = output || `speed_${speed}x_${Date.now()}.mp4`;
      const out = outputPath(outName);
      const vPts = 1 / speed;
      // atempo only supports 0.5–2.0 range, chain filters if needed
      let aTempo = "";
      let s = speed;
      const tempoFilters: string[] = [];
      while (s > 2.0) { tempoFilters.push("atempo=2.0"); s /= 2.0; }
      while (s < 0.5) { tempoFilters.push("atempo=0.5"); s /= 0.5; }
      tempoFilters.push(`atempo=${s.toFixed(4)}`);
      aTempo = tempoFilters.join(",");
      const filter = `[0:v]setpts=${vPts}*PTS[v];[0:a]${aTempo}[a]`;
      await ffmpeg(`-i "${input}" -filter_complex "${filter}" -map "[v]" -map "[a]" "${out}"`, 900000);
      return { content: [{ type: "text", text: `✅ Speed changed to ${speed}x\n📁 Saved: ${out}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── 15. MUTE SECTION ──────────────────────────────────────────────────────────
server.tool(
  "mute_section",
  "Silence audio between two timestamps. Useful for removing background noise or filler words.",
  {
    filepath: z.string().describe("Input video"),
    start: z.number().describe("Start second to mute"),
    end: z.number().describe("End second to mute"),
    output: z.string().optional().describe("Output filename"),
  },
  async ({ filepath, start, end, output }) => {
    try {
      const input = resolvePath(filepath);
      const outName = output || `muted_${Date.now()}.mp4`;
      const out = outputPath(outName);
      await ffmpeg(`-i "${input}" -af "volume=enable='between(t,${start},${end})':volume=0" -c:v copy "${out}"`);
      return { content: [{ type: "text", text: `✅ Muted ${start}s → ${end}s\n📁 Saved: ${out}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `❌ Error: ${e.message}` }] };
    }
  }
);

// ─── START ─────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
