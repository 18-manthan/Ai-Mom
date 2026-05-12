import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileAudio, RefreshCw, Sparkles, Trash2, UploadCloud } from "lucide-react";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";

type Meeting = {
  id: number;
  original_filename: string;
  status: "uploaded" | "processing" | "completed" | "failed";
  summary: string | null;
  summary_status: "not_started" | "queued" | "processing" | "completed" | "failed";
  summary_error: string | null;
  summary_preset: NotesPreset | null;
  processing_seconds: number | null;
  summary_seconds: number | null;
  cleanup_status: "not_started" | "queued" | "processing" | "completed" | "failed";
  cleanup_error: string | null;
  cleanup_seconds: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type NotesPreset = "short" | "detailed" | "citations" | "actions" | "team_sync" | "advice";

type Tab = "notes" | "transcript" | "insights";

type Segment = {
  start: number;
  end: number;
  speaker: string;
  text: string;
};

type MeetingDetail = Meeting & {
  language: string | null;
  language_probability: number | null;
  segments: Segment[];
  cleaned_segments: Segment[];
};

const NOTES_PRESETS: Array<{ value: NotesPreset; label: string; tag?: string }> = [
  { value: "short", label: "Short Summary" },
  { value: "detailed", label: "Detailed Summary" },
  { value: "citations", label: "Detailed Summary with Citations" },
  { value: "actions", label: "Summary and Action Items" },
  { value: "team_sync", label: "Team Sync - Project Updates" },
  { value: "advice", label: "Smart AI Advice", tag: "NEW" },
];

function formatTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function formatDuration(seconds: number | null) {
  if (seconds === null || seconds === undefined) return "--";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;

  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function App() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const [transcriptView, setTranscriptView] = useState<"raw" | "clean">("raw");
  const [activeTab, setActiveTab] = useState<Tab>("notes");
  const [notesPreset, setNotesPreset] = useState<NotesPreset>("short");

  async function loadMeetings() {
    const response = await fetch(`${API_BASE}/api/meetings`);
    const data = (await response.json()) as Meeting[];
    setMeetings(data);
    if (selectedId === null && data.length > 0) {
      setSelectedId(data[0].id);
    }
  }

  async function loadDetail(id: number) {
    const response = await fetch(`${API_BASE}/api/meetings/${id}`);
    setDetail((await response.json()) as MeetingDetail);
  }

  async function upload() {
    if (!file) return;
    setUploading(true);
    setMessage("");
    const form = new FormData();
    form.append("file", file);

    try {
      const response = await fetch(`${API_BASE}/api/meetings`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? "Upload failed");
      }
      const meeting = (await response.json()) as Meeting;
      setSelectedId(meeting.id);
      setFile(null);
      await loadMeetings();
      await loadDetail(meeting.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function generateSummary() {
    if (!detail) return;
    setMessage("");

    try {
      const response = await fetch(`${API_BASE}/api/meetings/${detail.id}/summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset: notesPreset }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? "Could not start summary generation");
      }
      const meeting = (await response.json()) as Meeting;
      setDetail({ ...detail, ...meeting });
      await loadMeetings();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start summary generation");
    }
  }

  async function cleanupTranscript() {
    if (!detail) return;
    setMessage("");

    try {
      const response = await fetch(`${API_BASE}/api/meetings/${detail.id}/cleanup`, {
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? "Could not start cleanup");
      }
      const meeting = (await response.json()) as Meeting;
      setDetail({ ...detail, ...meeting });
      await loadMeetings();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start cleanup");
    }
  }

  async function deleteMeeting(meeting: Meeting) {
    const confirmed = window.confirm(`Delete "${meeting.original_filename}"?`);
    if (!confirmed) return;
    setMessage("");

    try {
      const response = await fetch(`${API_BASE}/api/meetings/${meeting.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? "Delete failed");
      }

      const remaining = meetings.filter((item) => item.id !== meeting.id);
      setMeetings(remaining);
      if (selectedId === meeting.id) {
        const next = remaining[0] ?? null;
        setSelectedId(next?.id ?? null);
        setDetail(null);
        if (next) {
          await loadDetail(next.id);
        }
      }
      await loadMeetings();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Delete failed");
    }
  }

  useEffect(() => {
    loadMeetings().catch(() => setMessage("Backend is not reachable."));
  }, []);

  useEffect(() => {
    if (selectedId !== null) {
      loadDetail(selectedId).catch(() => setMessage("Could not load meeting."));
    }
  }, [selectedId]);

  useEffect(() => {
    if (detail && detail.cleaned_segments.length === 0 && transcriptView === "clean") {
      setTranscriptView("raw");
    }
    if (detail?.summary_preset) {
      setNotesPreset(detail.summary_preset);
    }
  }, [detail, transcriptView]);

  useEffect(() => {
    const active =
      detail?.status === "uploaded" ||
      detail?.status === "processing" ||
      detail?.cleanup_status === "queued" ||
      detail?.cleanup_status === "processing" ||
      detail?.summary_status === "queued" ||
      detail?.summary_status === "processing";
    if (!active || selectedId === null) return;

    const timer = window.setInterval(() => {
      loadMeetings().catch(() => undefined);
      loadDetail(selectedId).catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [detail?.status, detail?.cleanup_status, detail?.summary_status, selectedId]);

  const speakers = useMemo(() => {
    const names = new Set(detail?.segments.map((segment) => segment.speaker) ?? []);
    return Array.from(names);
  }, [detail]);

  const canGenerateSummary =
    detail?.status === "completed" &&
    detail.summary_status !== "queued" &&
    detail.summary_status !== "processing";

  const canCleanup =
    detail?.status === "completed" &&
    detail.cleanup_status !== "queued" &&
    detail.cleanup_status !== "processing";

  const displayedSegments =
    transcriptView === "clean" && detail?.cleaned_segments.length
      ? detail.cleaned_segments
      : detail?.segments ?? [];

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <FileAudio size={24} />
          <div>
            <h1>MOM</h1>
            <p>Meeting transcription</p>
          </div>
        </div>

        <section className="upload-panel">
          <label className="file-drop">
            <UploadCloud size={22} />
            <span>{file ? file.name : "Choose MP3, WAV, MP4, or M4A"}</span>
            <input
              type="file"
              accept=".mp3,.wav,.mp4,.m4a,audio/*,video/mp4"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <button className="primary" disabled={!file || uploading} onClick={upload}>
            {uploading ? "Uploading..." : "Upload"}
          </button>
          {message && <p className="error">{message}</p>}
        </section>

        <div className="list-head">
          <span>Meetings</span>
          <button className="icon-button" title="Refresh" onClick={loadMeetings}>
            <RefreshCw size={16} />
          </button>
        </div>

        <nav className="meeting-list">
          {meetings.map((meeting) => (
            <div
              key={meeting.id}
              className={meeting.id === selectedId ? "meeting active" : "meeting"}
            >
              <button className="meeting-main" onClick={() => setSelectedId(meeting.id)}>
                <span>{meeting.original_filename}</span>
                <small data-status={meeting.status}>
                  {meeting.status}
                  {meeting.processing_seconds !== null &&
                    ` · ${formatDuration(meeting.processing_seconds)}`}
                </small>
              </button>
              <button
                className="delete-button"
                title="Delete meeting"
                onClick={() => deleteMeeting(meeting)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {meetings.length === 0 && <p className="empty">No meetings yet.</p>}
        </nav>
      </aside>

      <section className="content">
        {!detail && (
          <div className="blank">
            <FileAudio size={36} />
            <p>Upload a meeting file to begin.</p>
          </div>
        )}

        {detail && (
          <>
            <header className="detail-head">
              <div>
                <h2>{detail.original_filename}</h2>
                <p>
                  Status: <strong>{detail.status}</strong>
                  {` · Transcription time: ${formatDuration(detail.processing_seconds)}`}
                  {detail.language && ` · Language: ${detail.language}`}
                </p>
              </div>
              <div className="speaker-count">{speakers.length || 0} speakers</div>
            </header>

            {detail.error && <div className="notice error-box">{detail.error}</div>}

            <nav className="tabs" aria-label="Meeting dashboard">
              <button className={activeTab === "notes" ? "selected" : ""} onClick={() => setActiveTab("notes")}>
                Notes
              </button>
              <button
                className={activeTab === "transcript" ? "selected" : ""}
                onClick={() => setActiveTab("transcript")}
              >
                Transcript
              </button>
              <button
                className={activeTab === "insights" ? "selected" : ""}
                onClick={() => setActiveTab("insights")}
              >
                Insights
              </button>
            </nav>

            {activeTab === "notes" && (
              <section className="dashboard-panel">
                <div className="tool-row">
                  <div>
                    <h3>AI Cleanup</h3>
                    <p>
                      {detail.cleanup_status.replace("_", " ")}
                      {detail.cleanup_seconds !== null &&
                        ` · ${formatDuration(detail.cleanup_seconds)}`}
                    </p>
                  </div>
                  <button className="secondary" disabled={!canCleanup} onClick={cleanupTranscript}>
                    <Sparkles size={16} />
                    AI Cleanup
                  </button>
                </div>
                {detail.cleanup_error && <div className="notice error-box">{detail.cleanup_error}</div>}

                <div className="notes-builder">
                  <label>
                    <span>AI Notes Preset</span>
                    <select
                      value={notesPreset}
                      onChange={(event) => setNotesPreset(event.target.value as NotesPreset)}
                    >
                      {NOTES_PRESETS.map((preset) => (
                        <option key={preset.value} value={preset.value}>
                          {preset.label}{preset.tag ? ` [${preset.tag}]` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="primary inline" disabled={!canGenerateSummary} onClick={generateSummary}>
                    <Sparkles size={16} />
                    Generate Notes
                  </button>
                </div>

                <section className="summary">
                  <div className="summary-head">
                    <div>
                      <h3>Notes</h3>
                      <p>
                        {detail.summary_status.replace("_", " ")}
                        {detail.summary_preset && ` · ${detail.summary_preset}`}
                        {detail.summary_seconds !== null &&
                          ` · ${formatDuration(detail.summary_seconds)}`}
                      </p>
                    </div>
                  </div>
                  {detail.summary_error && <div className="notice error-box">{detail.summary_error}</div>}
                  <pre>
                    {detail.summary ??
                      (detail.summary_status === "processing" || detail.summary_status === "queued"
                        ? "Generating notes..."
                        : "Choose a preset and generate notes after transcription is completed.")}
                  </pre>
                </section>
              </section>
            )}

            {activeTab === "transcript" && (
              <section className="dashboard-panel">
                <div className="transcript-head">
                  <h3>Transcript</h3>
                  <div className="segmented">
                    <button
                      className={transcriptView === "raw" ? "selected" : ""}
                      onClick={() => setTranscriptView("raw")}
                    >
                      Raw
                    </button>
                    <button
                      className={transcriptView === "clean" ? "selected" : ""}
                      disabled={detail.cleaned_segments.length === 0}
                      onClick={() => setTranscriptView("clean")}
                    >
                      Clean
                    </button>
                  </div>
                </div>
                {displayedSegments.length === 0 && (
                  <div className="notice">Transcript will appear after processing.</div>
                )}
                {displayedSegments.map((segment, index) => (
                  <article className="line" key={`${segment.start}-${index}`}>
                    <div className="meta">
                      <span>{segment.speaker}</span>
                      <time>
                        {formatTime(segment.start)} - {formatTime(segment.end)}
                      </time>
                    </div>
                    <p>{segment.text}</p>
                  </article>
                ))}
              </section>
            )}

            {activeTab === "insights" && (
              <section className="dashboard-panel insights-grid">
                <div className="metric">
                  <span>Speakers</span>
                  <strong>{speakers.length || 0}</strong>
                </div>
                <div className="metric">
                  <span>Raw Segments</span>
                  <strong>{detail.segments.length}</strong>
                </div>
                <div className="metric">
                  <span>Cleaned</span>
                  <strong>{detail.cleaned_segments.length ? "Yes" : "No"}</strong>
                </div>
                <div className="metric">
                  <span>Notes Preset</span>
                  <strong>{detail.summary_preset ?? "--"}</strong>
                </div>
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
