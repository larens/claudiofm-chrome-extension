function cleanProviderValue(value) {
  return String(value ?? "")
    .replace(/^[\s`'"]+|[\s`'"]+$/g, "")
    .trim();
}

function normalizeForCompare(value) {
  return cleanProviderValue(value).toLowerCase().replace(/\s+/g, "");
}

function scoreResolvedTrack(query, candidate) {
  const queryName = normalizeForCompare(query?.name || "");
  const queryArtist = normalizeForCompare(query?.artist || "");
  const candidateName = normalizeForCompare(candidate?.name || "");
  const candidateArtist = normalizeForCompare(candidate?.artist || "");

  let score = 0;
  if (!candidateName) return score;
  if (queryName && candidateName === queryName) score += 10;
  else if (queryName && candidateName.includes(queryName)) score += 6;
  else if (queryName && queryName.includes(candidateName)) score += 4;

  if (queryArtist && candidateArtist === queryArtist) score += 8;
  else if (queryArtist && candidateArtist.includes(queryArtist)) score += 5;
  else if (queryArtist && queryArtist.includes(candidateArtist)) score += 3;

  return score;
}

async function resolveTrack(track) {
  const name = String(track?.name || track?.query || "").trim();
  const artist = String(track?.artist || "").trim();
  console.log("[jamendo adapter] resolveTrack", { name, artist });
  if (!name) return null;

  try {
    const { preferences } = await chrome.storage.local.get("preferences");
    const clientId = preferences?.jamendoClientId || "";
    if (!clientId) {
      console.warn("[jamendo adapter] client_id not configured");
      return null;
    }

    const query = [name, artist].filter(Boolean).join(" ");
    const searchUrl = `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(clientId)}&format=json&limit=10&search=${encodeURIComponent(query)}&include=musicinfo&audioformat=mp31&order=popularity_total`;
    console.log("[jamendo adapter] search URL", searchUrl);

    const resp = await fetch(searchUrl);
    if (!resp.ok) { console.log("[jamendo adapter] search failed", resp.status); return null; }
    const data = await resp.json();
    if (data.headers?.status !== "success" || !data.results?.length) { console.log("[jamendo adapter] no results"); return null; }

    let bestResult = null;
    let bestScore = -1;

    for (const t of data.results) {
      const candidate = { name: t.name || "", artist: t.artist_name || "" };
      const score = scoreResolvedTrack({ name, artist }, candidate);
      console.log("[jamendo adapter] match", {
        jamendoId: t.id,
        score,
        streamUrl: t.audio,
        resolvedName: candidate.name,
        resolvedArtist: candidate.artist,
      });

      if (score > bestScore) {
        bestScore = score;
        bestResult = {
          provider: "jamendo",
          track: candidate,
          streamUrl: t.audio || "",
          cover: t.image || "",
          durationMs: (t.duration || 0) * 1000,
        };
      }

      if (score >= 18) break;
    }

    return bestResult?.streamUrl ? bestResult : null;
  } catch (e) {
    console.error("[jamendo adapter] error", e);
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "paojiao.resolveTrack") return undefined;

  resolveTrack(msg.track)
    .then((result) => sendResponse(result ?? null))
    .catch((error) => {
      console.error("[jamendo adapter] message resolve failed", error);
      sendResponse(null);
    });

  return true;
});

window.resolveTrackFromPaojiao = resolveTrack;
