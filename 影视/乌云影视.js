// @name 乌云影视
// @author nexu-agent
// @version 2.5.3
// @description 适配 v6.0 标准：修复缓存键碰撞导致的翻页失效，优化路由分发
// @indexs 0
// @dependencies axios,cheerio

/**
 * ============================================================================
 * 乌云影视 (wooyun.tv) - OmniBox 爬虫脚本 v2.5.3
 * ============================================================================
 * 修复记录：
 * 1. 缓存修正：修复 fetchWithCache 仅判断 body 长度导致的分页数据碰撞问题。
 * 2. 路由修正：精细化分发逻辑，确保存在 pg/page 参数时强制走分类流程。
 * 3. 性能修正：优化哈希计算，确保 Cache Key 严格遵守 SDK 256字节限制。
 * ============================================================================
 */

const OmniBox = require("omnibox_sdk");

// ==================== 配置层 ====================
const HOST = "https://wooyun.tv";
const API = "https://wooyun.tv/movie";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const PAGE_SIZE = 30;

let DANMU_API = (process.env.DANMU_API || "").trim();
if (DANMU_API.endsWith("/")) DANMU_API = DANMU_API.slice(0, -1);

const HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "Referer": HOST + "/",
  "Origin": HOST,
  "Connection": "keep-alive"
};

const CLASSES = [
  { type_id: "movie", type_name: "电影" },
  { type_id: "tv_series", type_name: "电视剧" },
  { type_id: "short_drama", type_name: "短剧" },
  { type_id: "animation", type_name: "动画" },
  { type_id: "variety", type_name: "综艺" }
];

// ==================== 核心工具层 ====================

function normalizeId(params) {
  let id = params.videoId || params.id || params.ids || "";
  if (Array.isArray(id)) id = id[0];
  if (typeof id === "string" && id.includes(",")) id = id.split(",")[0];
  return String(id).trim();
}

/**
 * 改进的哈希工具：确保 Body 差异体现在 Key 中
 */
function getSafeCacheKey(key) {
  // 如果 Key 过长，使用简单的旋转哈希算法
  if (key.length > 150) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash |= 0;
    }
    return `wooyun:h:${hash}`;
  }
  return key;
}

function getSafeUrl(path) {
  let targetUrl = path.startsWith("http") ? path : `${API}${path}`;
  if (targetUrl.startsWith("//")) targetUrl = "https:" + targetUrl;
  try {
    const parsed = new URL(targetUrl);
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|localhost)/.test(parsed.hostname)) {
      throw new Error("Blocked internal hostname");
    }
    return targetUrl;
  } catch (e) {
    throw new Error(`Security Check Failed: ${targetUrl}`);
  }
}

async function fetchWithCache(path, options = {}, useCache = false, exSeconds = 3600) {
  const url = getSafeUrl(path);
  // 核心修复：Key 必须包含 body 内容以区分不同分页
  const bodyContent = options.body ? String(options.body) : '';
  const rawKey = `wooyun:${options.method || 'GET'}:${url}:${bodyContent}`;
  const cacheKey = getSafeCacheKey(rawKey);

  if (useCache) {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) return cached;
  }

  const res = await OmniBox.request(url, {
    method: options.method || "GET",
    headers: HEADERS,
    timeout: 5000, 
    ...options
  });

  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  
  const data = JSON.parse(res.body || "{}");
  if (useCache && data) {
    await OmniBox.setCache(cacheKey, data, exSeconds);
  }
  return data;
}

// ==================== 逻辑实现层 ====================

function formatVideo(item) {
  if (!item || !item.id) return null;
  return {
    vod_id: String(item.id),
    vod_name: item.title || item.mediaName || item.originalTitle || "",
    vod_pic: item.posterUrlS3 || item.posterUrl || item.thumbnailUrl || "",
    vod_remarks: item.episodeStatus || ""
  };
}

async function home(params) {
  try {
    const res = await fetchWithCache("/media/home/custom/classify/1/3?limit=12", { method: "GET" }, true);
    const records = (res.data && res.data.records) || [];
    const list = records.reduce((acc, s) => {
      (s.mediaResources || []).forEach(item => {
        const f = formatVideo(item);
        if (f) acc.push(f);
      });
      return acc;
    }, []);
    return { class: CLASSES, list };
  } catch (e) {
    return { class: CLASSES, list: [] };
  }
}

async function category(params) {
  const pg = parseInt(params.pg || params.page) || 1;
  const detailId = normalizeId(params);

  // 修正路由：只有当明确要看详情且没有翻页意图时才转发
  if (params.ac === 'detail' && detailId && pg === 1) {
    return detail(params);
  }

  const tid = params.t || params.categoryId || params.id || "";
  
  try {
    const res = await fetchWithCache("/media/search", {
      method: "POST",
      body: JSON.stringify({ pageIndex: pg, pageSize: PAGE_SIZE, searchKey: "", topCode: tid })
    }, true);
    
    const data = res.data || {};
    const list = (data.records || []).map(formatVideo).filter(Boolean);
    
    // 乐观翻页算法
    let pageCount = data.pages || pg;
    if (list.length >= PAGE_SIZE) {
      pageCount = pg + 1;
    }

    return { 
      list, 
      page: pg, 
      pagecount: pageCount, 
      limit: PAGE_SIZE
    };
  } catch (e) {
    return { list: [], page: pg, pagecount: pg };
  }
}

async function search(params) {
  const wd = String(params.keyword || params.wd || "").trim().substring(0, 50); 
  const pg = parseInt(params.pg || params.page) || 1;
  if (!wd) return { list: [] };
  
  try {
    const res = await fetchWithCache("/media/search", {
      method: "POST",
      body: JSON.stringify({ searchKey: wd, pageIndex: pg, pageSize: PAGE_SIZE })
    }, true, 600);
    
    const data = res.data || {};
    const list = (data.records || []).map(formatVideo).filter(Boolean);
    
    let pageCount = data.pages || pg;
    if (list.length >= PAGE_SIZE) {
      pageCount = pg + 1;
    }

    return { list, page: pg, pagecount: pageCount };
  } catch (e) {
    return { list: [] };
  }
}

async function detail(params) {
  const id = normalizeId(params);
  if (!id) return { list: [] };
  try {
    const [detailRes, videoRes] = await Promise.all([
      fetchWithCache(`/media/base/detail?mediaId=${id}`, { method: "GET" }, true),
      fetchWithCache(`/media/video/list?mediaId=${id}`, { method: "GET" }, true)
    ]);
    const info = detailRes.data || detailRes;
    const seasons = videoRes.data || [];
    const vodPlaySources = [];
    for (const s of seasons) {
      const vids = s.videoList || [];
      if (!vids.length) continue;
      vodPlaySources.push({ 
        name: s.seasonNo ? `第${s.seasonNo}季` : "正片", 
        episodes: vids.map(ep => ({ name: ep.remark || `第${ep.epNo || 0}集`, playId: ep.playUrl || "" }))
      });
    }
    const vod_name = info.title || info.originalTitle || "";
    if (id && vod_name) {
      OmniBox.processScraping(id, vod_name, vod_name, []).catch(() => {});
    }
    return {
      list: [{
        vod_id: id,
        vod_name: vod_name,
        vod_pic: info.posterUrlS3 || info.posterUrl || "",
        type_name: (info.mediaType || {}).name || "",
        vod_year: info.releaseYear ? String(info.releaseYear) : "",
        vod_area: info.region || "",
        vod_director: (info.directors || []).join(" "),
        vod_actor: (info.actors || []).join(" "),
        vod_content: info.overview || info.description || "",
        vod_remarks: info.episodeStatus || "",
        vod_play_from: vodPlaySources.map(s => s.name).join("$$$") || undefined,
        vod_play_sources: vodPlaySources.length > 0 ? vodPlaySources : undefined
      }]
    };
  } catch (e) { return { list: [] }; }
}

async function play(params) {
  const playId = params.playId || "";
  const vodId = normalizeId(params);
  const vodName = (params.vodName || "").trim();
  const episodeName = (params.episodeName || "").trim();
  if (!playId) return { urls: [], parse: 0, header: {} };
  const result = {
    urls: [{ name: "乌云专线", url: playId }],
    parse: /\.(m3u8|mp4|flv|avi|mkv|ts)/i.test(playId) ? 0 : 1,
    header: { "User-Agent": UA, "Referer": HOST + "/", "Origin": HOST, "Connection": "keep-alive" }
  };
  if (vodId && vodName) {
    OmniBox.addPlayHistory({ vodId, title: vodName, episode: episodeName || "1", episodeName, pic: params.vodPic || "" }).catch(() => {});
  }
  const fileName = (vodName + " " + episodeName).trim();
  if (fileName) {
    try {
      let danmaku = await OmniBox.getDanmakuByFileName(fileName);
      if ((!danmaku || danmaku.length === 0) && DANMU_API) {
        const res = await OmniBox.request(`${DANMU_API}/api/v2/match`, {
          method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ fileName }), timeout: 3000
        });
        const dmData = JSON.parse(res.body || "{}");
        if (dmData.isMatched && dmData.matches?.[0]?.episodeId) {
          danmaku = [{ name: dmData.matches[0].animeTitle || "弹幕", url: `${DANMU_API}/api/v2/comment/${dmData.matches[0].episodeId}?format=xml` }];
        }
      }
      if (danmaku && danmaku.length > 0) result.danmaku = danmaku;
    } catch (e) {}
  }
  return result;
}

// ==================== 导出 ====================
module.exports = { home, category, search, detail, play };
const runner = require("spider_runner");
runner.run(module.exports);
