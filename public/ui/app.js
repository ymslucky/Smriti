'use strict';

/**
 * Smriti 记忆工作台（只读）。
 *
 * 数据：/v1/stats、/v1/topics、/v1/memories、/v1/pending、/v1/history、/v1/recall。
 * 约束：后端文本一律经 textContent 进入 DOM；不提供任何写入、裁决、删除操作。
 */
(function () {
  var LIST_LIMIT = 500;
  var RECALL_LIMIT = 50;
  var HISTORY_LIMIT = 30;
  var KIND_LABELS = {
    conflict: '冲突',
    'possible-duplicate': '疑似重复',
    'new-topic': '新主题'
  };

  var state = {
    stats: null,
    topics: [],
    topicLabels: new Map(),
    topicParents: new Map(),
    memories: [],
    byId: new Map(),
    pending: [],
    history: [],
    hits: [],
    view: 'list',
    query: '',
    topic: '',
    selectedId: null,
    searchSeq: 0,
    searchError: null,
    fatal: null,
    fetchedAt: null
  };

  var dom = {};

  /* ------------------------------------------------------------ utilities */

  function el(tag, props, children) {
    var node = document.createElement(tag);
    var key;
    if (props) {
      for (key in props) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
        var value = props[key];
        if (value === null || value === undefined) continue;
        if (key === 'text') {
          node.textContent = String(value);
        } else if (key === 'class') {
          node.className = value;
        } else if (key === 'attrs') {
          for (var name in value) {
            if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
            if (value[name] === null || value[name] === undefined) continue;
            node.setAttribute(name, String(value[name]));
          }
        } else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
          node.addEventListener(key.slice(2), value);
        } else if (key in node) {
          node[key] = value;
        } else {
          node.setAttribute(key, String(value));
        }
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i += 1) {
        var child = children[i];
        if (child === null || child === undefined || child === false) continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }
    }
    return node;
  }

  function text(value) {
    if (value === null || value === undefined) return '';
    var clean = String(value);
    return clean.trim() ? clean : '';
  }

  function formatCount(value) {
    var number = typeof value === 'number' ? value : Number(value);
    if (!isFinite(number) || number < 0) return '—';
    return String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function toDate(value) {
    if (!value) return null;
    var date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  function pad(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatTime(value) {
    var date = toDate(value);
    if (!date) return '—';
    return (
      date.getFullYear() +
      '-' +
      pad(date.getMonth() + 1) +
      '-' +
      pad(date.getDate()) +
      ' ' +
      pad(date.getHours()) +
      ':' +
      pad(date.getMinutes())
    );
  }

  function formatClock(value) {
    var date = toDate(value);
    if (!date) return '—';
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function labelPath(topic) {
    var key = text(topic);
    if (!key) return '—';
    var path = [];
    var cursor = key;
    for (var depth = 0; depth < 4 && cursor; depth += 1) {
      var label = state.topicLabels.get(cursor);
      if (!label) break;
      path.unshift(label);
      cursor = state.topicParents.get(cursor) || '';
    }
    if (path.length) return path.join(' · ');
    return state.topicLabels.get(key) || key;
  }

  function isWithinTopic(topic, scope) {
    var value = text(topic);
    var root = text(scope);
    if (!root) return true;
    return value === root || value.indexOf(root + '.') === 0;
  }

  /* ---------------------------------------------------------------- fetch */

  function HttpError(kind, status) {
    this.name = 'HttpError';
    this.kind = kind;
    this.status = status || 0;
    this.message = kind + (status ? ' ' + status : '');
  }
  HttpError.prototype = Object.create(Error.prototype);
  HttpError.prototype.constructor = HttpError;

  function request(path, options) {
    var init = {
      method: (options && options.method) || 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    if (options && options.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = options.body;
    }
    return fetch(path, init).then(
      function (response) {
        if (response.status === 401 || response.status === 403) {
          throw new HttpError('auth', response.status);
        }
        if (!response.ok) {
          return response.text().then(function () {
            throw new HttpError('http', response.status);
          });
        }
        return response.json().catch(function () {
          throw new HttpError('json', response.status);
        });
      },
      function () {
        throw new HttpError('network', 0);
      }
    );
  }

  function describeError(error) {
    if (error && error.kind === 'auth') return '需要 Cloudflare Access 登录，或 Access 策略未覆盖当前身份。';
    if (error && error.kind === 'network') return '网关不可达，检查网络或部署状态。';
    if (error && error.kind === 'json') return '网关返回了无法解析的响应。';
    if (error && error.kind === 'http') return '网关返回了错误（HTTP ' + error.status + '）。';
    return '读取失败。';
  }

  function announce(message) {
    if (dom.live) dom.live.textContent = message;
  }

  function showBanner(message) {
    dom.banner.hidden = false;
    dom.banner.textContent = message;
  }

  function hideBanner() {
    dom.banner.hidden = true;
    dom.banner.textContent = '';
  }

  function showState(container, options) {
    container.replaceChildren();
    var children = [el('p', { class: 'state__title', text: options.title })];
    if (options.body) children.push(el('p', { class: 'state__body', text: options.body }));
    if (options.actionLabel && typeof options.onAction === 'function') {
      children.push(
        el('div', { class: 'state__action' }, [
          el('button', {
            class: 'btn',
            type: 'button',
            text: options.actionLabel,
            onclick: options.onAction
          })
        ])
      );
    }
    container.appendChild(el('div', { class: 'state' }, children));
    container.hidden = false;
  }

  function clearState(container) {
    container.replaceChildren();
    container.hidden = true;
  }

  /* ----------------------------------------------------------------- data */

  function rememberTopic(item) {
    if (!item || !item.topic) return;
    if (item.label) state.topicLabels.set(item.topic, item.label);
    state.topicParents.set(item.topic, item.parent || null);
  }

  function loadStats() {
    return request('/v1/stats').then(function (payload) {
      state.stats = payload || {};
      if (Array.isArray(state.stats.byTopic)) state.stats.byTopic.forEach(rememberTopic);
      renderStats();
    });
  }

  function loadTopics() {
    return request('/v1/topics').then(function (payload) {
      state.topics = payload && Array.isArray(payload.topics) ? payload.topics : [];
      state.topics.forEach(rememberTopic);
      renderTree();
      renderTable();
    });
  }

  function loadMemories() {
    return request('/v1/memories?limit=' + LIST_LIMIT).then(function (payload) {
      state.memories = payload && Array.isArray(payload.items) ? payload.items : [];
      state.byId = new Map();
      state.memories.forEach(function (item) {
        if (item && item.id) state.byId.set(item.id, item);
      });
      renderTable();
      renderDetail();
    });
  }

  function loadPending() {
    return request('/v1/pending').then(function (payload) {
      state.pending = payload && Array.isArray(payload.pending) ? payload.pending : [];
      renderPending();
    });
  }

  function loadHistory() {
    return request('/v1/history?limit=' + HISTORY_LIMIT).then(function (payload) {
      state.history = payload && Array.isArray(payload.items) ? payload.items : [];
      renderHistory();
    });
  }

  function loadAll() {
    hideBanner();
    state.fatal = null;
    return Promise.all([
      loadStats().catch(noteFatal),
      loadTopics().catch(noteFatal),
      loadMemories().catch(noteFatal),
      loadPending().catch(noteFatal),
      loadHistory().catch(noteFatal)
    ]).then(function () {
      state.fetchedAt = new Date().toISOString();
      dom.fetchedAt.textContent = formatClock(state.fetchedAt) + ' 更新';
      dom.stats.setAttribute('aria-busy', 'false');
      renderTable();
      announce('已刷新');
    });
  }

  function noteFatal(error) {
    state.fatal = error;
    if (error && error.kind === 'auth') {
      showBanner('需要 Cloudflare Access 登录：刷新页面重新登录，或确认 Access 策略覆盖当前身份。');
    } else {
      showBanner(describeError(error));
    }
  }

  /* --------------------------------------------------------------- render */

  function renderStats() {
    var totals = (state.stats && state.stats.totals) || {};
    var health = (state.stats && state.stats.health) || {};
    dom.statMemories.textContent = formatCount(totals.memories);
    dom.statTopics.textContent = formatCount(totals.topics);
    dom.statPending.textContent = formatCount(totals.pending);
    dom.statSearch.textContent = health.aiSearch === true ? '就绪' : '未就绪';
    dom.statSearch.className = 'is-text' + (health.aiSearch === true ? '' : ' is-warn');
    dom.statPending.className = Number(totals.pending) > 0 ? 'is-warn' : '';
    // 主题接口还没回来时先用统计里的标签兜底。
    if (dom.treeAll) {
      dom.treeAll.setAttribute('aria-pressed', state.topic === '' ? 'true' : 'false');
    }
  }

  function renderTree() {
    var list = state.topics;
    dom.tree.replaceChildren();
    dom.topicsMeta.textContent = list.length
      ? list.length + ' 个主题'
      : '还没有主题';
    dom.treeAll.setAttribute('aria-pressed', state.topic === '' ? 'true' : 'false');

    var known = new Set(
      list.map(function (item) {
        return item.topic;
      })
    );
    // 词表按字典序返回，子主题紧跟在父主题之后；父主题不存在时按根行展示，避免"孤儿缩进"。
    var ordered = list.map(function (item) {
      return {
        item: item,
        child: Boolean(item.parent) && known.has(item.parent)
      };
    });

    var fragment = document.createDocumentFragment();
    ordered.forEach(function (entry) {
      var item = entry.item;
      var label = text(item.label) || text(item.topic);
      fragment.appendChild(
        el('li', null, [
          el('button', {
            class: 'tree__row' + (entry.child ? ' tree__row--child' : ''),
            type: 'button',
            attrs: {
              'aria-pressed': state.topic === item.topic ? 'true' : 'false',
              title: item.topic
            },
            onclick: function () {
              setTopic(item.topic);
            }
          }, [
            el('span', { class: 'tree__label', text: label }),
            el('span', { class: 'tree__count', text: formatCount(item.count) })
          ])
        ])
      );
    });
    dom.tree.appendChild(fragment);
    dom.tree.setAttribute('aria-busy', 'false');
  }

  function setTopic(topic) {
    state.topic = topic === state.topic ? '' : topic;
    state.hits = [];
    state.view = 'list';
    if (dom.q.value) dom.q.value = '';
    renderTree();
    renderTable();
    announce(state.topic ? '已筛选主题：' + labelPath(state.topic) : '已显示全部主题');
  }

  function visibleRows() {
    var rows = state.view === 'search' ? state.hits : state.memories;
    var filtered = rows.filter(function (item) {
      return item && isWithinTopic(item.topic, state.topic);
    });
    return filtered.slice().sort(function (left, right) {
      var a = toDate(left.updatedAt);
      var b = toDate(right.updatedAt);
      return (b ? b.getTime() : 0) - (a ? a.getTime() : 0);
    });
  }

  function renderTable() {
    var rows = visibleRows();

    // 当前选中的记录被筛掉时收起详情，避免右侧显示不在列表里的条目。
    if (
      state.selectedId &&
      !rows.some(function (item) {
        return item.id === state.selectedId;
      })
    ) {
      state.selectedId = null;
      renderDetail();
    }

    dom.recordCount.textContent = formatCount(rows.length) + ' 条';
    dom.memoriesMeta.textContent =
      (state.view === 'search' ? '语义检索「' + state.query + '」' : '按更新时间倒序') +
      (state.topic ? ' · 主题「' + labelPath(state.topic) + '」' : '');

    if (!rows.length) {
      dom.records.hidden = true;
      showState(dom.memoriesState, {
        title: state.view === 'search' ? '没有命中的记忆' : '没有记忆',
        body:
          state.view === 'search'
            ? '换一种说法，或清除检索回到完整列表。'
            : state.topic
              ? '这个主题下还没有记忆。清除主题筛选可以看全部。'
              : 'dsh 通过 memory_upsert 写入偏好；第一条写入后会出现在这里。',
        actionLabel: state.topic || state.view === 'search' ? '清除筛选' : undefined,
        onAction: clearFilters
      });
      return;
    }

    clearState(dom.memoriesState);
    dom.records.hidden = false;
    var fragment = document.createDocumentFragment();
    rows.forEach(function (item) {
      var selected = item.id === state.selectedId;
      fragment.appendChild(
        el('tr', {
          attrs: {
            tabindex: '0',
            'aria-selected': selected ? 'true' : 'false',
            'data-id': item.id
          },
          onclick: function () {
            selectRecord(item.id);
          },
          onkeydown: function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              selectRecord(item.id);
            }
          }
        }, [
          el('td', { class: 'cell-topic', attrs: { 'data-label': '主题' } }, [
            el('span', { text: labelPath(item.topic) }),
            el('small', { text: text(item.topic) })
          ]),
          el('td', { class: 'cell-statement', text: text(item.statement) || '（这条记录没有陈述）', attrs: { 'data-label': '陈述' } }),
          el('td', { class: 'cell-version', text: typeof item.version === 'number' ? 'v' + item.version : '—', attrs: { 'data-label': '版本' } }),
          el('td', { class: 'cell-time', text: formatTime(item.updatedAt), attrs: { 'data-label': '更新时间' } })
        ])
      );
    });
    dom.recordsBody.replaceChildren(fragment);
  }

  function selectRecord(id) {
    state.selectedId = id;
    renderTable();
    renderDetail();
    announce('已选择记忆 ' + id);
  }

  function renderDetail() {
    dom.detail.replaceChildren();
    dom.detail.appendChild(el('h2', { class: 'inspector__title', text: '详情' }));

    var record = state.selectedId ? state.byId.get(state.selectedId) : null;
    if (!record) {
      dom.detail.appendChild(
        el('p', { class: 'detail__empty', text: '选择左侧任意一条记忆，查看理由、版本与时间。' })
      );
      return;
    }

    dom.detail.appendChild(el('p', { class: 'detail__topic', text: labelPath(record.topic) }));
    dom.detail.appendChild(el('p', { class: 'detail__id', text: record.topic + ' / ' + record.id }));
    dom.detail.appendChild(el('p', { class: 'detail__statement', text: text(record.statement) }));
    if (text(record.rationale)) {
      dom.detail.appendChild(el('p', { class: 'detail__rationale', text: text(record.rationale) }));
    }

    var rows = [
      ['版本', 'v' + (record.version || 1)],
      ['生效', formatTime(record.validFrom || record.createdAt)],
      ['更新', formatTime(record.updatedAt)],
      ['置信度', typeof record.confidence === 'number' ? record.confidence.toFixed(2) : '—']
    ];
    if (record.supersedes) rows.push(['取代', record.supersedes]);
    if (record.source && record.source.session) rows.push(['来源', 'session ' + record.source.session]);

    var dl = el('dl', { class: 'detail__grid' });
    rows.forEach(function (row) {
      dl.appendChild(el('dt', { text: row[0] }));
      dl.appendChild(el('dd', { text: row[1] }));
    });
    dom.detail.appendChild(dl);
  }

  function renderHistory() {
    dom.historyCount.textContent = formatCount(state.history.length) + ' 条';
    dom.history.replaceChildren();
    if (!state.history.length) {
      showState(dom.historyState, {
        title: '没有历史',
        body: '被取代或删除的版本会出现在这里，保留 30 天。'
      });
      dom.history.hidden = true;
      return;
    }
    clearState(dom.historyState);
    dom.history.hidden = false;
    var fragment = document.createDocumentFragment();
    state.history.forEach(function (item) {
      fragment.appendChild(
        el('li', { class: 'timeline__row' }, [
          el('div', { class: 'timeline__meta' }, [
            el('span', { text: labelPath(item.topic) }),
            el('span', { text: item.validTo ? formatTime(item.validTo) : '—' })
          ]),
          el('p', { class: 'timeline__text', text: text(item.statement) || '（没有陈述）' }),
          item.archiveReason
            ? el('p', { class: 'timeline__reason', text: text(item.archiveReason) })
            : null
        ])
      );
    });
    dom.history.appendChild(fragment);
  }

  function renderPending() {
    dom.pendingCount.textContent = formatCount(state.pending.length) + ' 条';
    dom.pending.replaceChildren();
    if (!state.pending.length) {
      showState(dom.pendingState, {
        title: '没有待裁决',
        body: '冲突由调用方模型用 memory_resolve 自动处理，处理完就会消失。'
      });
      dom.pending.hidden = true;
      return;
    }
    clearState(dom.pendingState);
    dom.pending.hidden = false;
    var fragment = document.createDocumentFragment();
    state.pending.forEach(function (change) {
      var current = change.current ? change.current.statement : '（无现行记录）';
      fragment.appendChild(
        el('li', { class: 'pending__row' }, [
          el('span', { class: 'pending__kind', text: KIND_LABELS[change.kind] || change.kind }),
          el('p', { class: 'pending__pair', text: current + ' → ' + change.proposed.statement }),
          el('p', { class: 'pending__id', text: change.changeId })
        ])
      );
    });
    dom.pending.appendChild(fragment);
  }

  /* --------------------------------------------------------------- search */

  function runSearch(query) {
    var trimmed = text(query);
    if (!trimmed) {
      clearFilters();
      return;
    }
    var seq = state.searchSeq + 1;
    state.searchSeq = seq;
    state.view = 'search';
    state.query = trimmed;
    state.searchError = null;
    dom.searchSubmit.disabled = true;
    dom.searchSubmit.textContent = '搜索中…';
    dom.searchClear.hidden = false;

    request('/v1/recall', {
      method: 'POST',
      body: JSON.stringify({ query: trimmed, limit: RECALL_LIMIT })
    })
      .then(function (payload) {
        if (seq !== state.searchSeq) return;
        var items = payload && Array.isArray(payload.items) ? payload.items : [];
        state.hits = items.map(function (hit) {
          var full = state.byId.get(hit.id);
          if (!full) {
            return { id: hit.id, topic: hit.topic, statement: hit.statement };
          }
          return {
            id: full.id,
            topic: full.topic,
            statement: full.statement,
            version: full.version,
            updatedAt: full.updatedAt
          };
        });
        renderTable();
        announce('检索完成，命中 ' + state.hits.length + ' 条');
      })
      .catch(function (error) {
        if (seq !== state.searchSeq) return;
        state.hits = [];
        state.searchError = error;
        renderTable();
        showState(dom.memoriesState, {
          title: '检索失败',
          body: describeError(error) + ' 可以清除检索回到列表模式。',
          actionLabel: '清除检索',
          onAction: clearFilters
        });
      })
      .then(function () {
        if (seq !== state.searchSeq) return;
        dom.searchSubmit.disabled = false;
        dom.searchSubmit.textContent = '搜索';
      });
  }

  function clearFilters() {
    state.searchSeq += 1;
    state.view = 'list';
    state.query = '';
    state.hits = [];
    state.searchError = null;
    state.topic = '';
    dom.q.value = '';
    dom.searchSubmit.disabled = false;
    dom.searchSubmit.textContent = '搜索';
    dom.searchClear.hidden = true;
    renderTree();
    renderTable();
    announce('已清除筛选');
  }

  /* ----------------------------------------------------------------- init */

  function cacheDom() {
    dom.stats = document.getElementById('stats');
    dom.statMemories = document.getElementById('stat-memories');
    dom.statTopics = document.getElementById('stat-topics');
    dom.statPending = document.getElementById('stat-pending');
    dom.statSearch = document.getElementById('stat-search');
    dom.tree = document.getElementById('topic-tree');
    dom.treeAll = document.getElementById('tree-all');
    dom.topicsMeta = document.getElementById('topics-meta');
    dom.refresh = document.getElementById('refresh');
    dom.fetchedAt = document.getElementById('fetched-at');
    dom.memoriesMeta = document.getElementById('memories-meta');
    dom.recordCount = document.getElementById('record-count');
    dom.memoriesState = document.getElementById('memories-state');
    dom.records = document.getElementById('records');
    dom.recordsBody = document.getElementById('records-body');
    dom.q = document.getElementById('q');
    dom.searchForm = document.getElementById('search-form');
    dom.searchSubmit = document.getElementById('search-submit');
    dom.searchClear = document.getElementById('search-clear');
    dom.banner = document.getElementById('banner');
    dom.detail = document.getElementById('detail');
    dom.history = document.getElementById('history');
    dom.historyState = document.getElementById('history-state');
    dom.historyCount = document.getElementById('history-count');
    dom.pending = document.getElementById('pending');
    dom.pendingState = document.getElementById('pending-state');
    dom.pendingCount = document.getElementById('pending-count');
    dom.live = document.getElementById('live');
  }

  function bindEvents() {
    dom.refresh.addEventListener('click', function () {
      dom.refresh.disabled = true;
      loadAll().then(
        function () {
          dom.refresh.disabled = false;
        },
        function () {
          dom.refresh.disabled = false;
        }
      );
    });

    dom.treeAll.addEventListener('click', function () {
      state.topic = '';
      state.hits = [];
      state.view = 'list';
      renderTree();
      renderTable();
      announce('已显示全部主题');
    });

    dom.searchForm.addEventListener('submit', function (event) {
      event.preventDefault();
      runSearch(dom.q.value);
    });

    dom.searchClear.addEventListener('click', clearFilters);
  }

  function init() {
    cacheDom();
    bindEvents();
    loadAll();
  }

  init();
})();
