import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import express from 'express';
import type { Request, Response } from 'express';

interface IgPostItem {
  shortcode: string;
  kind: 'p' | 'reel';
  isVideo: boolean;
  typename: string;
  takenAt: number;
  url: string;
  embedUrl: string;
  thumbUrl: string;
  caption: string;
}

interface IgSnapshot {
  ok: boolean;
  username: string;
  fullName: string;
  postsCount: number;
  followersCount: number;
  profilePic: string;
  signature: string;
  posts: IgPostItem[];
  checkedAt: number;
}

const PORT = Number(process.env.PORT) || 3000;
const IG_USERNAME = 'pynn.br';
const IG_EMBED_URL = `https://www.instagram.com/${IG_USERNAME}/embed/`;
const CACHE_TTL_MS = 4000;

let cachedSnapshot: IgSnapshot | null = null;
let cacheTimestamp = 0;
let inFlightFetch: Promise<IgSnapshot> | null = null;

function toProxiedImageUrl(rawUrl: string): string {
  if (!rawUrl || !rawUrl.startsWith('https://')) return '';
  return `/api/instagram/img?url=${encodeURIComponent(rawUrl)}`;
}

function isAllowedIgImageHost(hostname: string): boolean {
  return /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(hostname);
}

async function fetchInstagramSnapshot(): Promise<IgSnapshot> {
  const now = Date.now();
  if (cachedSnapshot && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedSnapshot;
  }

  if (inFlightFetch) {
    return inFlightFetch;
  }

  inFlightFetch = (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 9000);
      const res = await fetch(IG_EMBED_URL, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!res.ok) {
        throw new Error(`Instagram HTTP ${res.status}`);
      }

      const html = await res.text();
      const match = html.match(/"contextJSON"\s*:\s*"(\{.*?\})"(?:,|\})/);
      if (!match) {
        throw new Error('Instagram contextJSON unavailable');
      }

      const decodedJson = JSON.parse(`"${match[1]}"`) as string;
      const parsed = JSON.parse(decodedJson) as {
        context?: {
          username?: string;
          full_name?: string;
          posts_count?: number;
          followers_count?: number;
          profile_pic_url?: string;
          graphql_media?: Array<{
            shortcode_media?: Record<string, unknown>;
            [key: string]: unknown;
          }>;
        };
      };

      const ctx = parsed.context || {};
      const mediaList = Array.isArray(ctx.graphql_media) ? ctx.graphql_media : [];

      const posts: IgPostItem[] = mediaList
        .map((entry): IgPostItem | null => {
          const node = (entry.shortcode_media || entry) as Record<string, unknown>;
          const shortcode = typeof node.shortcode === 'string' ? node.shortcode : '';
          if (!shortcode) return null;

          const typename = typeof node.__typename === 'string' ? node.__typename : 'GraphImage';
          const isVideo = Boolean(node.is_video) || typename === 'GraphVideo';
          const kind: 'p' | 'reel' = isVideo ? 'reel' : 'p';
          const takenAt = typeof node.taken_at_timestamp === 'number' ? node.taken_at_timestamp : 0;
          const displayUrl = typeof node.display_url === 'string' ? node.display_url : '';

          let caption = '';
          const capEdge = node.edge_media_to_caption as {
            edges?: Array<{ node?: { text?: string } }>;
          } | undefined;
          if (capEdge && Array.isArray(capEdge.edges) && capEdge.edges[0]?.node?.text) {
            caption = capEdge.edges[0].node.text.trim();
          } else if (typeof node.accessibility_caption === 'string') {
            caption = node.accessibility_caption.trim();
          }

          return {
            shortcode,
            kind,
            isVideo,
            typename,
            takenAt,
            url: `https://www.instagram.com/${kind}/${shortcode}/`,
            embedUrl: `https://www.instagram.com/${kind}/${shortcode}/embed/`,
            thumbUrl: toProxiedImageUrl(displayUrl),
            caption,
          };
        })
        .filter((item): item is IgPostItem => item !== null);

      const postsCount = typeof ctx.posts_count === 'number' ? ctx.posts_count : posts.length;
      const followersCount = typeof ctx.followers_count === 'number' ? ctx.followers_count : 0;
      const fullName = typeof ctx.full_name === 'string' ? ctx.full_name : 'PYNN';
      const username = typeof ctx.username === 'string' ? ctx.username : IG_USERNAME;
      const profilePic = toProxiedImageUrl(
        typeof ctx.profile_pic_url === 'string' ? ctx.profile_pic_url : ''
      );

      const signature = [
        postsCount,
        fullName,
        posts.map((p) => `${p.shortcode}:${p.takenAt}`).join(','),
      ].join('|');

      const snapshot: IgSnapshot = {
        ok: true,
        username,
        fullName,
        postsCount,
        followersCount,
        profilePic,
        signature,
        posts,
        checkedAt: Date.now(),
      };

      cachedSnapshot = snapshot;
      cacheTimestamp = Date.now();
      return snapshot;
    } finally {
      inFlightFetch = null;
    }
  })();

  return inFlightFetch;
}

const GMP_SOLUTION_ID = 'gmp_mcp_codeassist_v1_aistudio';

function getGoogleMapsApiKey(): string {
  return (
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    ''
  ).trim();
}

interface ExtractedBrLocation {
  placeId: string;
  formattedAddress: string;
  postalCode: string;
  stateCode: string;
  stateName: string;
  city: string;
  viewport: {
    low?: { latitude: number; longitude: number };
    high?: { latitude: number; longitude: number };
  } | null;
}

function extractBrLocation(result: Record<string, unknown> | null | undefined): ExtractedBrLocation {
  const empty: ExtractedBrLocation = {
    placeId: '',
    formattedAddress: '',
    postalCode: '',
    stateCode: '',
    stateName: '',
    city: '',
    viewport: null,
  };
  if (!result || typeof result !== 'object') return empty;

  const placeId =
    (typeof result.placeId === 'string' && result.placeId) ||
    (typeof result.place_id === 'string' && result.place_id) ||
    (typeof result.id === 'string' && result.id) ||
    '';

  const formattedAddress =
    (typeof result.formattedAddress === 'string' && result.formattedAddress) ||
    (typeof result.formatted_address === 'string' && result.formatted_address) ||
    '';

  let postalCode = '';
  let stateCode = '';
  let stateName = '';
  let city = '';

  const postalAddress = result.postalAddress as Record<string, unknown> | undefined;
  if (postalAddress && typeof postalAddress === 'object') {
    if (typeof postalAddress.postalCode === 'string') postalCode = postalAddress.postalCode;
    if (typeof postalAddress.administrativeArea === 'string') {
      const admin = postalAddress.administrativeArea.trim();
      if (admin.length === 2) stateCode = admin.toUpperCase();
      else stateName = admin;
    }
    if (typeof postalAddress.locality === 'string') city = postalAddress.locality.trim();
  }

  const comps = (
    Array.isArray(result.addressComponents)
      ? result.addressComponents
      : Array.isArray(result.address_components)
      ? result.address_components
      : []
  ) as Array<Record<string, unknown>>;

  for (const comp of comps) {
    const types = Array.isArray(comp.types) ? comp.types : [];
    const longVal =
      (typeof comp.longText === 'string' && comp.longText) ||
      (typeof comp.long_name === 'string' && comp.long_name) ||
      '';
    const shortVal =
      (typeof comp.shortText === 'string' && comp.shortText) ||
      (typeof comp.short_name === 'string' && comp.short_name) ||
      '';

    if (types.includes('administrative_area_level_1')) {
      if (shortVal && shortVal.length <= 3) stateCode = shortVal.toUpperCase();
      if (longVal) stateName = longVal;
    } else if (types.includes('locality')) {
      if (longVal) city = longVal;
    } else if (!city && types.includes('administrative_area_level_2')) {
      if (longVal) city = longVal;
    } else if (!postalCode && types.includes('postal_code')) {
      if (longVal || shortVal) postalCode = longVal || shortVal;
    }
  }

  let viewport: ExtractedBrLocation['viewport'] = null;
  const rawViewport = result.viewport as Record<string, unknown> | undefined;
  if (rawViewport && typeof rawViewport === 'object') {
    const low = rawViewport.low as { latitude?: number; longitude?: number } | undefined;
    const high = rawViewport.high as { latitude?: number; longitude?: number } | undefined;
    if (
      low &&
      high &&
      typeof low.latitude === 'number' &&
      typeof low.longitude === 'number' &&
      typeof high.latitude === 'number' &&
      typeof high.longitude === 'number'
    ) {
      viewport = {
        low: { latitude: low.latitude, longitude: low.longitude },
        high: { latitude: high.latitude, longitude: high.longitude },
      };
    }
  }

  return {
    placeId,
    formattedAddress,
    postalCode,
    stateCode,
    stateName,
    city,
    viewport,
  };
}

function isQuotaErrorPayload(status: number, body: unknown): boolean {
  if (status === 429) return true;
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  const err = obj.error as Record<string, unknown> | undefined;
  if (err && (err.status === 'RESOURCE_EXHAUSTED' || err.code === 429)) return true;
  if (obj.status === 'OVER_QUERY_LIMIT' || obj.status === 'RESOURCE_EXHAUSTED') return true;
  return false;
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/maps/health', (_req: Request, res: Response) => {
    res.json({ ok: true, hasServerKey: Boolean(getGoogleMapsApiKey()) });
  });

  // CEP lookup via official Google Maps Geocoding API (v4 primary + REST fallback)
  app.get('/api/maps/cep', async (req: Request, res: Response) => {
    const apiKey = getGoogleMapsApiKey();
    if (!apiKey) {
      res.status(503).json({ ok: false, error: 'Google Maps API key unavailable on server' });
      return;
    }

    const rawCep = typeof req.query.cep === 'string' ? req.query.cep : '';
    const digits = rawCep.replace(/\D/g, '');
    if (digits.length !== 8) {
      res.status(400).json({ ok: false, error: 'Invalid CEP format' });
      return;
    }
    const formattedCep = `${digits.slice(0, 5)}-${digits.slice(5)}`;
    const lang = typeof req.query.lang === 'string' && req.query.lang ? req.query.lang : 'pt-BR';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const v4Params = new URLSearchParams({
        'address.postalCode': formattedCep,
        'address.regionCode': 'BR',
        languageCode: lang,
      });

      const v4Res = await fetch(
        `https://geocode.googleapis.com/v4/geocode/address?${v4Params.toString()}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-Maps-Solution-ID': GMP_SOLUTION_ID,
            'X-Goog-FieldMask':
              'results.placeId,results.formattedAddress,results.postalAddress,results.addressComponents,results.viewport',
          },
          signal: controller.signal,
        }
      ).finally(() => clearTimeout(timeout));

      const v4Data = (await v4Res.json().catch(() => ({}))) as Record<string, unknown>;
      if (isQuotaErrorPayload(v4Res.status, v4Data)) {
        res.status(429).json({ ok: false, quotaExceeded: true, error: 'Quota exceeded' });
        return;
      }

      const v4Results = Array.isArray(v4Data.results) ? v4Data.results : [];
      if (v4Res.ok && v4Results.length > 0) {
        const parsed = extractBrLocation(v4Results[0] as Record<string, unknown>);
        if (parsed.stateCode || parsed.stateName || parsed.city) {
          res.json({ ok: true, result: parsed });
          return;
        }
      }

      // Fallback to standard Geocoding REST API if v4 returns empty or unsupported
      const v1Controller = new AbortController();
      const v1Timeout = setTimeout(() => v1Controller.abort(), 8000);
      const v1Params = new URLSearchParams({
        components: `postal_code:${digits}|country:BR`,
        language: lang,
        key: apiKey,
      });
      const v1Res = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?${v1Params.toString()}`,
        { signal: v1Controller.signal }
      ).finally(() => clearTimeout(v1Timeout));

      const v1Data = (await v1Res.json().catch(() => ({}))) as Record<string, unknown>;
      if (isQuotaErrorPayload(v1Res.status, v1Data)) {
        res.status(429).json({ ok: false, quotaExceeded: true, error: 'Quota exceeded' });
        return;
      }

      const v1Results = Array.isArray(v1Data.results) ? v1Data.results : [];
      if (v1Res.ok && v1Results.length > 0) {
        const parsed = extractBrLocation(v1Results[0] as Record<string, unknown>);
        res.json({ ok: true, result: parsed });
        return;
      }

      if (v1Data.status === 'REQUEST_DENIED' || v4Res.status === 403) {
        res.status(502).json({ ok: false, error: 'Geocoding upstream denied' });
        return;
      }

      res.json({ ok: true, result: null });
    } catch {
      res.status(502).json({ ok: false, error: 'Failed to look up CEP' });
    }
  });

  // Places API (New) Autocomplete proxy for cities and states
  app.post('/api/maps/autocomplete', async (req: Request, res: Response) => {
    const apiKey = getGoogleMapsApiKey();
    if (!apiKey) {
      res.status(503).json({ ok: false, error: 'Google Maps API key unavailable on server' });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const input = typeof body.input === 'string' ? body.input.trim() : '';
    if (!input) {
      res.json({ ok: true, suggestions: [] });
      return;
    }

    const includedPrimaryTypes = Array.isArray(body.includedPrimaryTypes)
      ? body.includedPrimaryTypes.filter((t): t is string => typeof t === 'string')
      : undefined;
    const languageCode = typeof body.languageCode === 'string' && body.languageCode ? body.languageCode : 'pt-BR';
    const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken : undefined;
    const locationBias =
      body.locationBias && typeof body.locationBias === 'object' ? body.locationBias : undefined;

    const payload: Record<string, unknown> = {
      input,
      includedRegionCodes: ['br'],
      regionCode: 'br',
      languageCode,
    };
    if (includedPrimaryTypes && includedPrimaryTypes.length > 0) {
      payload.includedPrimaryTypes = includedPrimaryTypes;
    }
    if (sessionToken) {
      payload.sessionToken = sessionToken;
    }
    if (locationBias) {
      payload.locationBias = locationBias;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const upstream = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-Maps-Solution-ID': GMP_SOLUTION_ID,
          'X-Goog-FieldMask':
            'suggestions.placePrediction.placeId,suggestions.placePrediction.place,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
      if (isQuotaErrorPayload(upstream.status, data)) {
        res.status(429).json({ ok: false, quotaExceeded: true, error: 'Quota exceeded' });
        return;
      }
      if (!upstream.ok) {
        res.status(502).json({ ok: false, error: `Places autocomplete error ${upstream.status}` });
        return;
      }

      const rawSuggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
      const suggestions = rawSuggestions
        .map((s) => {
          const pred = (s as Record<string, unknown>)?.placePrediction as Record<string, unknown> | undefined;
          if (!pred) return null;
          const textObj = pred.text as { text?: string } | undefined;
          const structObj = pred.structuredFormat as
            | { mainText?: { text?: string }; secondaryText?: { text?: string } }
            | undefined;
          return {
            placeId: typeof pred.placeId === 'string' ? pred.placeId : '',
            fullText: typeof textObj?.text === 'string' ? textObj.text : '',
            mainText: typeof structObj?.mainText?.text === 'string' ? structObj.mainText.text : (textObj?.text || ''),
            secondaryText: typeof structObj?.secondaryText?.text === 'string' ? structObj.secondaryText.text : '',
            types: Array.isArray(pred.types) ? pred.types : [],
          };
        })
        .filter((x) => x && x.placeId);

      res.json({ ok: true, suggestions });
    } catch {
      res.status(502).json({ ok: false, error: 'Places autocomplete unavailable' });
    }
  });

  // Places API (New) Place Details proxy for extracting addressComponents + viewport
  app.get('/api/maps/place', async (req: Request, res: Response) => {
    const apiKey = getGoogleMapsApiKey();
    if (!apiKey) {
      res.status(503).json({ ok: false, error: 'Google Maps API key unavailable on server' });
      return;
    }

    const placeId = typeof req.query.placeId === 'string' ? req.query.placeId.trim() : '';
    if (!placeId || !/^[A-Za-z0-9_-]{8,200}$/.test(placeId)) {
      res.status(400).json({ ok: false, error: 'Invalid placeId' });
      return;
    }
    const lang = typeof req.query.lang === 'string' && req.query.lang ? req.query.lang : 'pt-BR';
    const sessionToken = typeof req.query.sessionToken === 'string' ? req.query.sessionToken : '';

    const params = new URLSearchParams({
      languageCode: lang,
      regionCode: 'br',
    });
    if (sessionToken) params.set('sessionToken', sessionToken);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const upstream = await fetch(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?${params.toString()}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-Maps-Solution-ID': GMP_SOLUTION_ID,
            'X-Goog-FieldMask':
              'id,displayName,formattedAddress,addressComponents,postalAddress,viewport,types',
          },
          signal: controller.signal,
        }
      ).finally(() => clearTimeout(timeout));

      const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
      if (isQuotaErrorPayload(upstream.status, data)) {
        res.status(429).json({ ok: false, quotaExceeded: true, error: 'Quota exceeded' });
        return;
      }
      if (!upstream.ok) {
        res.status(502).json({ ok: false, error: `Place details error ${upstream.status}` });
        return;
      }

      const parsed = extractBrLocation(data);
      const displayNameObj = data.displayName as { text?: string } | undefined;
      res.json({
        ok: true,
        place: {
          ...parsed,
          displayName: typeof displayNameObj?.text === 'string' ? displayNameObj.text : '',
        },
      });
    } catch {
      res.status(502).json({ ok: false, error: 'Place details unavailable' });
    }
  });

  app.get('/api/instagram', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const snapshot = await fetchInstagramSnapshot();
      res.json(snapshot);
    } catch (err) {
      if (cachedSnapshot) {
        res.json({ ...cachedSnapshot, stale: true });
        return;
      }
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Unable to reach Instagram',
      });
    }
  });

  app.get('/api/instagram/img', async (req: Request, res: Response) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      res.status(400).send('Invalid image URL');
      return;
    }

    if (parsedUrl.protocol !== 'https:' || !isAllowedIgImageHost(parsedUrl.hostname)) {
      res.status(403).send('Disallowed image host');
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const upstream = await fetch(parsedUrl.toString(), {
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      const contentType = upstream.headers.get('content-type') || '';
      if (!upstream.ok || !contentType.startsWith('image/')) {
        res.status(502).send('Upstream image unavailable');
        return;
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(buf);
    } catch {
      res.status(502).send('Image fetch error');
    }
  });

  const resolveErrorPage = (filename: string): string => {
    const distCandidate = path.resolve(process.cwd(), 'dist', filename);
    if (process.env.NODE_ENV === 'production' && fs.existsSync(distCandidate)) {
      return distCandidate;
    }
    return path.resolve(process.cwd(), 'public', filename);
  };

  const sendBrandedError = (res: Response, statusCode: number, filename: string): void => {
    const filePath = resolveErrorPage(filename);
    if (fs.existsSync(filePath)) {
      res.status(statusCode).sendFile(filePath);
      return;
    }
    res.status(statusCode).send(`HTTP ${statusCode}`);
  };

  app.get(['/403', '/403.html'], (_req: Request, res: Response) => sendBrandedError(res, 403, '403.html'));
  app.get(['/404', '/404.html'], (_req: Request, res: Response) => sendBrandedError(res, 404, '404.html'));
  app.get(['/500', '/500.html'], (_req: Request, res: Response) => sendBrandedError(res, 500, '500.html'));
  app.get(['/503', '/503.html'], (_req: Request, res: Response) => sendBrandedError(res, 503, '503.html'));
  app.get(['/offline', '/offline.html'], (_req: Request, res: Response) => sendBrandedError(res, 200, 'offline.html'));

  app.all('/api/*', (_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'Endpoint not found' });
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get(['/', '/index.html'], (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
    app.use((_req: Request, res: Response) => {
      sendBrandedError(res, 404, '404.html');
    });
  } else {
    app.get('/pynn-site-novo.zip', (_req: Request, res: Response) => {
      const zipPath = path.join(os.tmpdir(), `pynn-site-${Date.now()}.zip`);
      const pyScript = `
import os, sys, zipfile
root = os.path.abspath(sys.argv[1])
out_zip = sys.argv[2]
skip_dirs = {'node_modules', 'dist', 'build', '.git', '.aistudio', '.gmp_cache', 'coverage'}
skip_prefixes = ('public/assets/aistudio/',)
with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
  for dirpath, dirnames, filenames in os.walk(root):
    rel_dir = os.path.relpath(dirpath, root).replace(os.sep, '/')
    if rel_dir == '.':
      rel_dir = ''
    dirnames[:] = [d for d in dirnames if d not in skip_dirs and not (rel_dir + '/' + d + '/').lstrip('/').startswith(skip_prefixes)]
    for fn in filenames:
      if fn == '.DS_Store' or fn.endswith('.log'):
        continue
      if fn.startswith('.env') and fn != '.env.example':
        continue
      full = os.path.join(dirpath, fn)
      arc = (rel_dir + '/' + fn).lstrip('/')
      if arc.startswith(skip_prefixes):
        continue
      zf.write(full, arc)
`;
      execFile('/usr/bin/python3', ['-c', pyScript, process.cwd(), zipPath], (err) => {
        if (err || !fs.existsSync(zipPath)) {
          res.status(500).send('Erro ao gerar o arquivo ZIP.');
          return;
        }
        res.download(zipPath, 'pynn-site-novo.zip', () => {
          fs.unlink(zipPath, () => {});
        });
      });
    });

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(vite.middlewares);

    app.use(async (req: Request, res: Response, next) => {
      try {
        if (req.path === '/' || req.path === '/index.html') {
          const htmlPath = path.resolve(process.cwd(), 'index.html');
          const template = fs.readFileSync(htmlPath, 'utf-8');
          const html = await vite.transformIndexHtml(req.originalUrl, template);
          res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
          return;
        }
        sendBrandedError(res, 404, '404.html');
      } catch (e) {
        next(e);
      }
    });
  }

  app.use((err: unknown, req: Request, res: Response, _next: express.NextFunction) => {
    console.error('Unhandled request error:', err);
    if (req.path.startsWith('/api/')) {
      res.status(500).json({ ok: false, error: 'Internal server error' });
      return;
    }
    sendBrandedError(res, 500, '500.html');
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PYNN server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
