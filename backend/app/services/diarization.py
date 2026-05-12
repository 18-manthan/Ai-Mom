from pathlib import Path
from typing import Any

import librosa
import numpy as np
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler

from ..config import settings


def _feature_for_window(y: np.ndarray, sr: int) -> np.ndarray:
    if y.size < sr // 5:
        y = np.pad(y, (0, max(0, sr // 5 - y.size)))

    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)
    bandwidth = librosa.feature.spectral_bandwidth(y=y, sr=sr)
    zcr = librosa.feature.zero_crossing_rate(y)
    rms = librosa.feature.rms(y=y)

    return np.concatenate(
        [
            np.mean(mfcc, axis=1),
            np.std(mfcc, axis=1),
            np.mean(centroid, axis=1),
            np.mean(bandwidth, axis=1),
            np.mean(zcr, axis=1),
            np.mean(rms, axis=1),
        ]
    )


def _best_cluster_count(features: np.ndarray) -> int:
    max_k = min(settings.max_speakers, len(features) - 1)
    if max_k < 2:
        return 1

    best_k = 1
    best_score = -1.0
    for k in range(2, max_k + 1):
        labels = AgglomerativeClustering(n_clusters=k).fit_predict(features)
        if len(set(labels)) < 2:
            continue
        score = silhouette_score(features, labels)
        if score > best_score:
            best_k = k
            best_score = score
    return best_k


def assign_speakers(audio_path: Path, segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not segments:
        return []

    y, sr = librosa.load(audio_path, sr=16000, mono=True)
    features = []
    usable_segments = []

    for segment in segments:
        start_sample = max(0, int(float(segment["start"]) * sr))
        end_sample = min(len(y), int(float(segment["end"]) * sr))
        if end_sample <= start_sample:
            continue
        features.append(_feature_for_window(y[start_sample:end_sample], sr))
        usable_segments.append(segment)

    if len(features) < 2:
        return [{**segment, "speaker": "Speaker 1"} for segment in segments]

    scaled = StandardScaler().fit_transform(np.vstack(features))
    k = _best_cluster_count(scaled)
    if k == 1:
        labels = np.zeros(len(usable_segments), dtype=int)
    else:
        labels = AgglomerativeClustering(n_clusters=k).fit_predict(scaled)

    labels_by_segment_id = {id(segment): int(label) for segment, label in zip(usable_segments, labels)}
    speaker_map: dict[int, str] = {}
    next_speaker = 1
    labeled = []

    for segment in segments:
        label = labels_by_segment_id.get(id(segment), 0)
        if label not in speaker_map:
            speaker_map[label] = f"Speaker {next_speaker}"
            next_speaker += 1
        labeled.append({**segment, "speaker": speaker_map[label]})

    return labeled
