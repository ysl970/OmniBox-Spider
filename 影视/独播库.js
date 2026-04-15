// @name 独播库
// @author @caipeibin
// @description 独播库 OmniBox 工业级标准版 v1.6.0：修复播放拖动卡顿、适配 SDK 弹幕/历史记录/媒体探测。
// @version 1.6.0
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/影视/采集/独播库.js
// @indexs 0

const OmniBox = require("omnibox_sdk");
const crypto = require("crypto");

// ==================== 配置区域 ====================
const HOST = "https://api.dbokutv.com";
const REFERER_HOST = "https://www.duboku.tv";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const ITEM_LIMIT = 20;

// API 专用 headers（仅发往 api.dbokutv.com）
const API_HEADERS = {
    "User-Agent": UA,
    "Content-Type": "application/json",
    "Referer": `${REFERER_HOST}/`,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
};

// ==================== 工具函数 ====================

// 安全缓存 Key：防 256 字节溢出
const getSafeCacheKey = (prefix, key) => {
    const rawKey = `${prefix}:${key}`;
    return rawKey.length > 64 ? crypto.createHash('md5').update(rawKey).digest('hex') : rawKey;
};

// ID 归一化：兼容逗号分割 / 数组
const normalizeId = (params) => {
    let id = params.videoId || params.id || params.ids || "";
    if (typeof id === "string" && id.includes(",")) id = id.split(",")[0];
    if (Array.isArray(id)) id = id[0];
    return String(id || "");
};

// API 请求封装（仅对 api.dbokutv.com）
const fetchJson = async (url, options = {}) => {
    try {
        const response = await OmniBox.request(url, {
            method: options.method || "GET",
            headers: { ...API_HEADERS, ...(options.headers || {}) },
            body: options.body,
            timeout: 10000
        });
        if (response.statusCode !== 200) return null;
        return JSON.parse(response.body);
    } catch { return null; }
};

// 独播库数据解密：分段 reverse + base64
const decodeDubokuData = (data) => {
    if (!data || typeof data !== 'string') return '';
    const str = data.trim().replace(/['"]/g, '');
    if (!str) return '';
    const segmentLength = 10;
    try {
        const processedArray = [];
        for (let i = 0; i < str.length; i += segmentLength) {
            const segment = str.slice(i, i + segmentLength);
            let reversed = '';
            for (let j = segment.length - 1; j >= 0; j--) reversed += segment[j];
            processedArray.push(reversed);
        }
        let b64 = processedArray.join('').replace(/\./g, '=');
        const pad = 4 - (b64.length % 4);
        if (pad !== 4) b64 += '='.repeat(pad);
        return Buffer.from(b64, 'base64').toString('utf-8');
    } catch { return ''; }
};

// 签名生成：为同一个 playId 缓存签名，避免每次请求产生不同 URL
// 缓存 key: "sig:<playId_md5>"，有效期 5 分钟
const _sigCache = {};
const generateSignature = (url) => {
    const cacheKey = `sig:${url}`;
    const now = Date.now();
    if (_sigCache[cacheKey] && now - _sigCache[cacheKey].ts < 300000) {
        return _sigCache[cacheKey].url;
    }
    const ts = Math.floor(now / 1000).toString();
    const rand = Math.floor(Math.random() * 800000000);
    const ssid = Buffer.from(interleaveStrings(`${rand + 100000000}${900000000 - rand}`, ts)).toString('base64').replace(/=/g, '.');
    const sign = crypto.randomBytes(30).toString('hex');
    const token = crypto.randomBytes(19).toString('hex');
    const signed = `${url}${url.includes('?') ? '&' : '?'}sign=${sign}&token=${token}&ssid=${ssid}`;
    _sigCache[cacheKey] = { url: signed, ts: now };
    return signed;
};

const interleaveStrings = (str1, str2) => {
    let res = '';
    const minLen = Math.min(str1.length, str2.length);
    for (let i = 0; i < minLen; i++) res += str1[i] + str2[i];
    return res + str1.slice(minLen) + str2.slice(minLen);
};

// ==================== 接口实现 ====================

async function home() {
    const cacheKey = "home:default";
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) return cached;

    const classes = [
        { type_id: "2", type_name: "连续剧" },
        { type_id: "3", type_name: "综艺" },
        { type_id: "1", type_name: "电影" },
        { type_id: "4", type_name: "动漫" }
    ];
    try {
        const data = await fetchJson(generateSignature(`${HOST}/home`));
        const list = [];
        if (Array.isArray(data)) {
            for (const cat of data) {
                for (const vod of (cat.VodList || [])) {
                    if (list.length >= ITEM_LIMIT) break;
                    list.push({
                        vod_id: decodeDubokuData(vod.DId || vod.DuId),
                        vod_name: vod.Name || '',
                        vod_pic: decodeDubokuData(vod.TnId),
                        vod_remarks: vod.Tag || ''
                    });
                }
                if (list.length >= ITEM_LIMIT) break;
            }
        }
        const result = { class: classes, filters: {}, list };
        await OmniBox.setCache(cacheKey, result, 600);
        return result;
    } catch {
        return { class: classes, list: [] };
    }
}

async function category(params) {
    if (params.ac === 'detail') return detail(params);

    const { categoryId, page = 1 } = params;
    const cacheKey = getSafeCacheKey("category", `${categoryId}:${page}`);
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) return cached;

    try {
        const pageStr = page === 1 ? '' : page.toString();
        const url = generateSignature(`${HOST}/vodshow/${categoryId}--------${pageStr}---`);
        const data = await fetchJson(url);

        // 解析列表（添加 type_id / type_name 供 TVBox 渲染）
        const list = [];
        if (data?.VodList && Array.isArray(data.VodList)) {
            for (const vod of data.VodList) {
                if (list.length >= ITEM_LIMIT) break;
                list.push({
                    vod_id: decodeDubokuData(vod.DId || vod.DuId),
                    vod_name: vod.Name || '',
                    vod_pic: decodeDubokuData(vod.TnId),
                    vod_remarks: vod.Tag || '',
                    type_id: categoryId,
                    type_name: data.Title || ''
                });
            }
        }

        // 解析真实页数
        let pagecount = 1;
        if (data?.PaginationList && Array.isArray(data.PaginationList)) {
            for (const p of data.PaginationList) {
                if (p.Name && p.Name.includes('/')) {
                    const match = p.Name.match(/(\d+)\/(\d+)/);
                    if (match) pagecount = parseInt(match[2]) || 1;
                }
            }
        }

        // 解析筛选器
        const filters = {};
        if (data?.FilterList && Array.isArray(data.FilterList)) {
            for (const f of data.FilterList) {
                if (!f.Class || !f.OptionList) continue;
                // 跳过"字母"筛选（选项太多，UI 不友好）
                if (f.Class === '字母') continue;
                filters[f.Class] = f.OptionList.map(o => ({
                    name: o.Option,
                    value: o.Option === '全部' ? '' : o.Option
                }));
            }
        }

        const result = {
            list,
            page: parseInt(page),
            pagecount,
            limit: ITEM_LIMIT,
            total: pagecount * ITEM_LIMIT,
            filters
        };
        await OmniBox.setCache(cacheKey, result, 600);
        return result;
    } catch { return { list: [], page: 1 }; }
}

async function search(params) {
    const keyword = params.keyword || "";
    const cacheKey = getSafeCacheKey("search", keyword);
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) return cached;

    try {
        const url = generateSignature(`${HOST}/vodsearch`) + `&wd=${encodeURIComponent(keyword)}`;
        const data = await fetchJson(url);
        const list = [];
        if (Array.isArray(data)) {
            for (const vod of data) {
                if (list.length >= ITEM_LIMIT) break;
                list.push({
                    vod_id: decodeDubokuData(vod.DId || vod.DuId),
                    vod_name: vod.Name || '',
                    vod_pic: decodeDubokuData(vod.TnId),
                    vod_remarks: vod.Tag || '',
                    vod_actor: vod.Actor || ''
                });
            }
        }
        const result = { list, page: 1, pagecount: 1, limit: list.length, total: list.length };
        await OmniBox.setCache(cacheKey, result, 300);
        return result;
    } catch { return { list: [] }; }
}

async function detail(params) {
    const videoId = normalizeId(params);
    if (!videoId) return { list: [] };

    const cacheKey = getSafeCacheKey("detail", videoId);
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) return cached;

    try {
        const detailPath = videoId.startsWith('/') ? videoId : `/${videoId}`;
        const data = await fetchJson(generateSignature(HOST + detailPath));
        if (!data || !data.Playlist) return { list: [] };

        const playUrls = [];
        const episodes = (data.Playlist || []).map((ep, i) => {
            const vid = decodeDubokuData(ep.VId);
            if (!vid) return null;
            const name = ep.EpisodeName || `第${i + 1}集`;
            playUrls.push(`${name}$${vid}`);
            return { name, playId: vid, _fid: `${videoId}#0#${i}` };
        }).filter(e => e);

        const detailData = {
            vod_id: videoId,
            vod_name: data.Name || '',
            vod_pic: decodeDubokuData(data.TnId),
            vod_remarks: data.Tag || '',
            vod_year: data.ReleaseYear || '',
            vod_area: data.Region || '',
            vod_actor: Array.isArray(data.Actor) ? data.Actor.join(',') : data.Actor || '',
            vod_director: data.Director || '',
            vod_content: data.Description || '',
            vod_play_from: '独播库',
            vod_play_url: playUrls.join('#'),
            vod_play_sources: [{ name: '独播库', episodes: episodes.map(e => ({ name: e.name, playId: e.playId })) }]
        };

        // 刮削：使用真实的播放 URL，而非 fid
        const scrapeFiles = episodes
            .filter(e => e.playId.startsWith('http') || e.playId.startsWith('/'))
            .slice(0, 3) // 只取前 3 集，减少无效请求
            .map(e => ({ fid: e.playId, file_id: e.playId, name: e.name, format_type: "video" }));
        if (scrapeFiles.length > 0) {
            OmniBox.processScraping(videoId, detailData.vod_name, detailData.vod_name, scrapeFiles).catch(() => {});
        }

        const result = { list: [detailData] };
        await OmniBox.setCache(cacheKey, result, 3600);
        return result;
    } catch { return { list: [] }; }
}

async function play(params) {
    const playId = params.playId || params.play || "";
    const vodName = params.vodName || "";
    const episodeName = params.episodeName || "";

    if (!playId) return { urls: [], parse: 1 };

    try {
        const finalUrl = playId.startsWith('http') ? playId : HOST + (playId.startsWith('/') ? playId : `/${playId}`);

        // 用干净的 headers 请求播放地址（不发 Content-Type 给 CDN）
        const data = await OmniBox.request(generateSignature(finalUrl), {
            headers: {
                "User-Agent": UA,
                "Referer": "https://w.duboku.io/"
            },
            timeout: 10000
        });

        if (data.statusCode !== 200) throw new Error(`API ${data.statusCode}`);
        const body = JSON.parse(data.body || "{}");
        const videoUrl = decodeDubokuData(body?.HId);
        if (!videoUrl) throw new Error("No HId");

        // 判断播放模式
        const isDirect = /\.(m3u8|mp4|flv|mkv|ts)(\?|$|#)/i.test(videoUrl);

        const res = {
            urls: [{ name: "播放", url: videoUrl }],
            parse: isDirect ? 0 : 1
        };

        // 播放头（仅 Referer + UA，去掉 Content-Type / Accept-Encoding / Connection）
        if (!isDirect) {
            res.header = { "User-Agent": UA, "Referer": "https://w.duboku.io/" };
        } else {
            res.header = { "Referer": "https://w.duboku.io/" };
        }

        // 弹幕：优先使用自建 DANMU_API，兜底 SDK 原生方法
        let danmakuFound = false;
        const envDanmuApi = await OmniBox.getEnv("DANMU_API");
        if (envDanmuApi && vodName) {
            try {
                const epNum = episodeName?.match(/\d+/)?.[0] || "01";
                const matchName = `${vodName} S01E${epNum.padStart(2, '0')}`;
                const dmRes = await OmniBox.request(`${envDanmuApi}/api/v2/match`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ fileName: matchName })
                });
                if (dmRes.statusCode === 200) {
                    const dmData = JSON.parse(dmRes.body || "{}");
                    if (dmData.isMatched && dmData.matches?.[0]) {
                        const m = dmData.matches[0];
                        res.danmaku = [{ name: "自动弹幕", url: `${envDanmuApi}/api/v2/comment/${m.episodeId}?format=xml` }];
                        danmakuFound = true;
                    }
                }
            } catch {}
        }
        // 自建 API 未命中时，尝试 SDK 原生弹幕
        if (!danmakuFound && episodeName) {
            try {
                const danmaku = await OmniBox.getDanmakuByFileName(episodeName);
                if (danmaku && danmaku.length > 0) {
                    res.danmaku = danmaku.slice(0, 1);
                    danmakuFound = true;
                }
            } catch {}
        }

        // 播放历史（SDK 原生方法）
        try {
            const mediaInfo = await OmniBox.getVideoMediaInfo(videoUrl, { Referer: "https://w.duboku.io/" });
            const duration = Number(mediaInfo?.format?.duration || 0);
            const epNum = episodeName?.match(/\d+/)?.[0] || '1';
            await OmniBox.addPlayHistory({
                vodId: params.vodId || '',
                title: vodName,
                episode: playId,
                episodeNumber: Number(epNum),
                episodeName: episodeName,
                totalDuration: duration
            });
        } catch {}

        return res;
    } catch (e) {
        await OmniBox.log("error", `播放异常: ${e.message}`);
        // 回退：先判断是否为直链
        if (/\.(m3u8|mp4|flv|mkv|ts)(\?|$|#)/i.test(playId)) {
            return { urls: [{ name: "播放", url: playId }], parse: 0, header: { Referer: "https://w.duboku.io/" } };
        }
        return { urls: [{ name: "回退", url: playId }], parse: 1 };
    }
}

module.exports = { home, category, search, detail, play };
const runner = require("spider_runner");
runner.run(module.exports);
