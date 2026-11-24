'use strict';

/**
 * Smriti 只读视图前端。
 *
 * 约束：
 * - 无框架、无外部依赖；
 * - 后端文本一律经 textContent 进入 DOM，本文件没有任何 innerHTML 赋值；
 * - 只读：这里没有写入、审批、删除请求。
 */
(function () {
  var RECALL_LIMIT = 50;
  var LIST_LIMIT = 200;
  var KIND_LABELS = {
    conflict: '冲突',
    'possible-duplicate': '疑似重复',
    'new-topic': '新主题'
  };
  var KIND_CLASSES = {
    conflict: 'conflict',
    'possible-duplicate': 'duplicate',
    'new-topic': 'new'
  };

  /* ---------------------------------------------------------------- state */

  var state = {
    topics: [],
    byTopic: [],
    topicLabels: new Map(),
    memories: [],
    memoriesLoaded: false,
    pending: [],
    hits: [],
    searchError: null,
    view: 'list',
    query: '',
    topic: '',
    stats: null,
    recentItems: [],
    health: null,
    healthCheck: 'unknown',
    fetchedAt: null,
    fatalError: null,
    loading: false,
    searching: false,
    searchSeq: 0
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
        node.appendChild(
          typeof child === 'string' ? document.createTextNode(child) : child
        );
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

  /** 稳定的本地时间显示：YYYY-MM-DD HH:mm。 */
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

  function formatConfidence(value) {
    var number = typeof value === 'number' ? value : Number(value);
    if (!isFinite(number)) return '—';
    return number.toFixed(2);
  }

  function timeEl(value, className) {
    var date = toDate(value);
    var attrs = {};
    if (date) attrs.datetime = value;
    return el('time', {
      class: className || '',
      text: date ? formatTime(value) : '—',
      attrs: attrs
    });
  }

  function announce(message) {
    if (!dom.live) return;
    dom.live.textContent = message;
  }

  function setBusy(node, busy) {
    if (!node) return;
    node.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function flagEnter(node) {
    if (!node) return;
    node.classList.remove('is-enter');
    /* 强制一次重排，让重复刷新也能重放这段 180ms 的入场。 */
    void node.offsetWidth;
    node.classList.add('is-enter');
  }

  function labelFor(topic) {
    var key = text(topic);
    if (!key) return '—';
    return state.topicLabels.get(key) || key;
  }

  /* ---------------------------------------------------------------- fetch */

  function HttpError(kind, detail, status) {
    this.name = 'HttpError';
    this.kind = kind;
    this.detail = detail || '';
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
        if (response.status === 401) return Promise.reject(new HttpError('auth', '', 401));
        if (response.status === 403) return Promise.reject(new HttpError('forbidden', '', 403));
        if (!response.ok) return Promise.reject(new HttpError('http', '', response.status));
        return response.json().catch(function () {
          return Promise.reject(new HttpError('parse', '', response.status));
        });
      },
      function () {
        return Promise.reject(new HttpError('network', '', 0));
      }
    );
  }

  function describeError(error) {
    var kind = error && error.kind;
    if (kind === 'auth') {
      return {
        title: '需要 Cloudflare Access 鉴权',
        hint: '刷新页面重新登录，或确认 Access 策略覆盖当前身份。',
        body: '这个页面在 Access 之后，同源 cookie 没有通过校验。刷新页面重新登录；若用 service token 访问，确认 Access 策略覆盖了当前身份。'
      };
    }
    if (kind === 'forbidden') {
      return {
        title: '没有访问权限（HTTP 403）',
        hint: '确认 Access 策略包含当前身份。',
        body: 'Cloudflare Access 返回 403：当前身份的 Access 策略没有覆盖这个应用。请重新登录，或让策略包含你的邮箱。'
      };
    }
    if (kind === 'network') {
      return {
        title: '网关不可达',
        hint: '检查网络，或确认 Worker 已部署、Access 应用在线。',
        body: '请求没有到达 Worker。检查网络，或确认 smriti 的子域已部署、Access 应用在线；本地开发请确认 wrangler dev 仍在运行。'
      };
    }
    if (kind === 'http') {
      return {
        title: '网关返回了错误（HTTP ' + (error.status || '?') + '）',
        hint: '服务端错误，稍后重试；持续出现请看 Worker 日志。',
        body: '这是服务端错误，稍后重试；如果持续出现，查看 Worker 日志与 R2 绑定。'
      };
    }
    if (kind === 'parse') {
      return {
        title: '响应不是有效的 JSON',
        hint: '返回体可能被登录页或代理错误页替换。',
        body: '返回体可能来自 Access 登录页或代理错误页，而不是 Worker 的 JSON 响应。刷新页面重试一次。'
      };
    }
    return {
      title: '读取失败',
      hint: '重试一次；持续出现请看浏览器控制台与 Worker 日志。',
      body: '发生了未知错误，重试一次；如果持续出现，查看浏览器控制台与 Worker 日志。'
    };
  }

  /* 这三种失败是整页级的：页面顶部横幅统一说明，各区块只留一行指过去。 */
  var GATE_KINDS = { auth: true, forbidden: true, network: true };

  function isGateError(error) {
    return !!(error && GATE_KINDS[error.kind]);
  }

  function noteFatal(error) {
    if (!error) return;
    if (isGateError(error) && !state.fatalError) state.fatalError = error;
  }

  /* ---------------------------------------------------------- state views */

  function showState(container, options) {
    if (!container) return;
    var children = [
      el('p', {
        class:
          'state__title' + (options.tone === 'error' ? ' is-error' : ''),
        text: options.title
      })
    ];
    if (options.body) {
      children.push(el('p', { class: 'state__body', text: options.body }));
    }
    if (options.actionLabel && typeof options.onAction === 'function') {
      children.push(
        el('div', { class: 'state__actions' }, [
          el('button', {
            class: 'btn',
            type: 'button',
            text: options.actionLabel,
            onclick: options.onAction
          })
        ])
      );
    }
    container.replaceChildren(
      el(
        'div',
        {
          class: 'state',
          attrs: options.tone === 'error' ? { role: 'alert' } : null
        },
        children
      )
    );
    container.hidden = false;
  }

  function hideState(container) {
    if (!container) return;
    container.replaceChildren();
    container.hidden = true;
  }

  /** 区块级错误：一行说明问题与恢复路径，不重复整页横幅的正文。 */
  function sectionError(container, title, hint, retry) {
    if (!container) return;
    var children = [
      el('span', { class: 'inline-error__mark', attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'inline-error__text' }, [
        el('strong', { class: 'inline-error__title', text: title }),
        el('span', { class: 'inline-error__body', text: hint })
      ])
    ];
    if (typeof retry === 'function') {
      children.push(
        el('button', {
          class: 'btn btn--small',
          type: 'button',
          text: '重试',
          onclick: retry
        })
      );
    }
    container.replaceChildren(
      el('div', { class: 'inline-error', attrs: { role: 'alert' } }, children)
    );
    container.hidden = false;
  }

  function sectionErrorFrom(container, error, retry) {
    var info = describeError(error);
    if (isGateError(error)) {
      sectionError(container, '读取失败', '原因见页面顶部提示。', null);
      return;
    }
    sectionError(container, info.title, info.hint, retry);
  }

  function showGate(error) {
    if (!error) {
      dom.gate.hidden = true;
      return;
    }
    var info = describeError(error);
    dom.gateTitle.textContent = info.title;
    dom.gateBody.textContent = info.body;
    dom.gate.hidden = false;
  }

  /* ------------------------------------------------------------ nav counts */

  function setNavCount(name, value, alertWhenPositive) {
    var node = document.querySelector('[data-count="' + name + '"]');
    if (!node) return;
    var hasValue = value !== null && value !== undefined && isFinite(Number(value));
    node.textContent = hasValue ? formatCount(Number(value)) : '';
    if (alertWhenPositive) {
      node.classList.toggle('is-alert', hasValue && Number(value) > 0);
    }
  }

  /* ---------------------------------------------------------------- stats */

  function loadStats() {
    setBusy(dom.totals, true);
    return request('/v1/stats').then(
      function (data) {
        var payload = data || {};
        var totals = payload.totals || {};
        var health = payload.health || {};
        var recent = Array.isArray(payload.recent) ? payload.recent : [];

        state.health = health;
        state.stats = payload;
        state.recentItems = recent;
        state.byTopic = Array.isArray(payload.byTopic) ? payload.byTopic : [];

        /* 先登记标签，再渲染：否则最近更新会先拿到原始 topic 标识。 */
        state.byTopic.forEach(function (item) {
          if (item && item.topic && item.label && !state.topicLabels.has(item.topic)) {
            state.topicLabels.set(item.topic, item.label);
          }
        });

        renderTotals(totals, health);
        renderRecent(recent);

        setNavCount('memories', totals.memories, false);
        setNavCount('pending', totals.pending, true);
        setNavCount('topics', totals.topics, false);

        setBusy(dom.totals, false);
      },
      function (error) {
        noteFatal(error);
        state.stats = null;
        state.recentItems = [];
        dom.statMemories.textContent = '—';
        dom.statPending.textContent = '—';
        dom.statTopics.textContent = '—';
        dom.statSearch.textContent = '—';
        dom.statSearch.className = 'totals__num totals__num--text';
        dom.recent.hidden = true;
        setBusy(dom.recent, false);
        sectionErrorFrom(dom.recentState, error, refreshAll);
        setBusy(dom.totals, false);
        throw error;
      }
    );
  }

  function renderTotals(totals, health) {
    dom.statMemories.textContent = formatCount(totals.memories);
    dom.statPending.textContent = formatCount(totals.pending);
    dom.statTopics.textContent = formatCount(totals.topics);
    dom.statPendingNote.textContent =
      Number(totals.pending) > 0 ? '在 dsh 里裁决' : '没有积压';
    dom.statPendingNote.className = 'totals__note';

    var ready = health.aiSearch === true;
    dom.statSearch.textContent = ready ? '就绪' : '未就绪';
    dom.statSearch.className =
      'totals__num totals__num--text ' + (ready ? 'is-ok' : 'is-warn');
    // 统计带的说明保持一行短语；具体原因放在下方运行状态的「检索」行，避免长文本撑坏版面。
    dom.statSearchNote.textContent = ready ? '语义检索可用' : '检索降级为列表';
  }

  function renderRecent(items) {
    dom.recent.replaceChildren();
    if (!items.length) {
      dom.recent.hidden = true;
      showState(dom.recentState, {
        title: '还没有记忆',
        body: 'dsh 通过 memory_upsert 写入偏好；第一条写进来之后，最近更新会出现在这里。'
      });
      return;
    }
    dom.recent.hidden = false;
    hideState(dom.recentState);

    var fragment = document.createDocumentFragment();
    items.slice(0, 5).forEach(function (item) {
      fragment.appendChild(
        el('li', { class: 'recent__row' }, [
          timeEl(item.updatedAt, 'recent__time'),
          el('span', { class: 'recent__topic', text: labelFor(item.topic) }),
          el('span', {
            class: 'recent__text',
            text: text(item.statement) || '（这条记录没有陈述）'
          })
        ])
      );
    });
    dom.recent.appendChild(fragment);
    setBusy(dom.recent, false);
    flagEnter(dom.recent);
  }

  /* --------------------------------------------------------------- health */

  function loadHealth() {
    return request('/v1/health').then(
      function () {
        state.healthCheck = 'ok';
        return null;
      },
      function (error) {
        state.healthCheck = 'fail';
        return null;
      }
    );
  }

  function renderStatus() {
    var health = state.health || {};
    var rows = [];

    rows.push({
      label: '健康检查',
      values: [
        {
          text:
            state.healthCheck === 'ok'
              ? '通过'
              : state.healthCheck === 'fail'
                ? '未通过'
                : '未知',
          className:
            state.healthCheck === 'ok'
              ? 'is-ok'
              : state.healthCheck === 'fail'
                ? 'is-bad'
                : ''
        }
      ]
    });

    rows.push({
      label: '实例',
      values: [
        {
          text: text(health.instance) || '—',
          className: ''
        }
      ]
    });

    rows.push({
      label: '鉴权',
      values: [{ text: authModeLabel(health.authMode), className: '' }]
    });

    // 检索后端不健康时把原因摆到台面上：以前只显示"未就绪"，没人知道是实例没了。
    if (health.aiSearch === false && text(health.searchError)) {
      rows.push({
        label: '检索',
        values: [{ text: text(health.searchError), className: 'is-bad' }]
      });
    }

    rows.push({
      label: '数据获取',
      values: [
        {
          text: state.fetchedAt ? formatTime(state.fetchedAt) : '—',
          className: ''
        }
      ]
    });

    dom.status.replaceChildren();
    rows.forEach(function (row) {
      dom.status.appendChild(
        el('div', { class: 'status__row' }, [
          el('dt', { text: row.label }),
          el('dd', null, row.values.map(function (value) {
            return el('span', { class: value.className, text: value.text });
          }))
        ])
      );
    });
    setBusy(dom.status, false);
  }

  function authModeLabel(mode) {
    var value = text(mode).toLowerCase();
    if (!value) return '—';
    if (value === 'access') return 'Cloudflare Access';
    if (value === 'dev') return 'dev（跳过 Access）';
    return text(mode);
  }

  /* --------------------------------------------------------------- topics */

  function loadTopics() {
    setBusy(dom.topicList, true);
    return request('/v1/topics').then(
      function (data) {
        var list = data && Array.isArray(data.topics) ? data.topics : [];
        state.topics = list;
        list.forEach(function (item) {
          if (item && item.topic && item.label) {
            state.topicLabels.set(item.topic, item.label);
          }
        });
        renderTopics(list);
        renderTopicFilter(list);
        setBusy(dom.topicList, false);
      },
      function (error) {
        noteFatal(error);
        dom.topicsMeta.textContent = '读取失败';
        dom.topicList.hidden = true;
        sectionErrorFrom(dom.topicState, error, refreshAll);
        setBusy(dom.topicList, false);
        throw error;
      }
    );
  }

  function renderTopics(list) {
    dom.topicList.replaceChildren();
    if (!list.length) {
      dom.topicList.hidden = true;
      dom.topicsMeta.textContent = '没有主题';
      showState(dom.topicState, {
        title: '主题词表是空的',
        body: '12 个固定主题来自 src/topics.ts。若 /v1/topics 返回空数组，说明这次部署的词表没有加载。'
      });
      return;
    }
    dom.topicList.hidden = false;
    hideState(dom.topicState);

    var total = 0;
    var max = 1;
    list.forEach(function (item) {
      var count = Number(item && item.count) || 0;
      total += count;
      if (count > max) max = count;
    });
    dom.topicsMeta.textContent =
      list.length + ' 个固定主题 · 共 ' + formatCount(total) + ' 条记忆';

    var fragment = document.createDocumentFragment();
    list.forEach(function (item) {
      var count = Number(item && item.count) || 0;
      var label = text(item.label) || text(item.topic);
      fragment.appendChild(
        el('li', { class: 'shelf__row' }, [
          el('span', { class: 'shelf__name' }, [
            el('span', { class: 'shelf__label', text: label }),
            el('span', { class: 'shelf__id', text: text(item.topic) })
          ]),
          el('span', {
            class: 'shelf__desc',
            text: text(item.description) || '（这个词表项没有说明）'
          }),
          el('span', { class: 'shelf__meter' }, [
            el('progress', {
              class: 'meter',
              value: count,
              max: max,
              attrs: {
                'aria-label': label + '：' + formatCount(count) + ' 条记忆'
              }
            })
          ]),
          el('span', { class: 'shelf__count', text: formatCount(count) })
        ])
      );
    });
    dom.topicList.appendChild(fragment);
    flagEnter(dom.topicList);
  }

  function renderTopicFilter(list) {
    var current = dom.topicFilter.value;
    dom.topicFilter.replaceChildren(
      el('option', { value: '', text: '全部主题' })
    );
    list.forEach(function (item) {
      /* 只放标签，不放计数：检索模式下计数会与命中数混淆，计数归「主题」区块。 */
      dom.topicFilter.appendChild(
        el('option', {
          value: text(item.topic),
          text: text(item.label) || text(item.topic)
        })
      );
    });
    dom.topicFilter.value = current;
    state.topic = dom.topicFilter.value;
  }

  /* ------------------------------------------------------------- memories */

  function loadMemories() {
    setBusy(dom.memoryBody, true);
    return request('/v1/memories?limit=' + LIST_LIMIT).then(
      function (data) {
        state.memories = data && Array.isArray(data.items) ? data.items : [];
        state.memoriesLoaded = true;
        if (state.view === 'search') {
          state.hits = hydrateHits(state.hits);
        }
        renderMemories();
        setBusy(dom.memoryBody, false);
      },
      function (error) {
        noteFatal(error);
        state.memoriesLoaded = false;
        state.searchError = null;
        dom.records.hidden = true;
        dom.memoriesMeta.textContent = '读取失败';
        sectionErrorFrom(dom.memoryState, error, refreshAll);
        setBusy(dom.memoryBody, false);
        throw error;
      }
    );
  }

  function hydrateHits(hits) {
    var index = new Map();
    state.memories.forEach(function (item) {
      if (item && item.id) index.set(item.id, item);
    });
    return hits.map(function (hit) {
      var full = index.get(hit.id);
      if (!full) {
        return {
          id: hit.id,
          topic: hit.topic,
          statement: hit.statement
        };
      }
      return {
        id: hit.id,
        topic: hit.topic || full.topic,
        statement: text(hit.statement) || full.statement,
        version: full.version,
        updatedAt: full.updatedAt
      };
    });
  }

  function visibleRows() {
    var rows = state.view === 'search' ? state.hits : state.memories;
    if (!state.topic) return rows;
    return rows.filter(function (item) {
      return item && item.topic === state.topic;
    });
  }

  function renderMemories() {
    var all = state.view === 'search' ? state.hits : state.memories;
    var rows = visibleRows();
    var topicLabel = state.topic ? labelFor(state.topic) : '';

    dom.searchClear.hidden = state.view !== 'search';
    dom.searchMode.className =
      'mode-line' + (state.view === 'search' ? ' is-search' : '');
    dom.searchMode.textContent =
      state.view === 'search'
        ? '语义检索 · 来自 AI Search，按相关度排列'
        : '列表模式 · 按更新时间排列，最多 ' + LIST_LIMIT + ' 条';

    if (state.view === 'search' && state.searchError) {
      var info = describeError(state.searchError);
      dom.records.hidden = true;
      dom.memoriesMeta.textContent = '语义检索失败';
      sectionError(
        dom.memoryState,
        info.title,
        '语义检索请求失败；AI Search 未就绪时 /v1/recall 可能不可用，也可以清除搜索改用列表浏览。',
        function () {
          runSearch(state.query);
        }
      );
      return;
    }

    if (!rows.length) {
      dom.records.hidden = true;
      if (state.view === 'search') {
        if (all.length) {
          dom.memoriesMeta.textContent =
            '语义检索「' + state.query + '」· 命中 ' + formatCount(all.length) + ' 条 · 当前筛选 0 条';
          showState(dom.memoryState, {
            title: '「' + topicLabel + '」没有命中的记忆',
            body:
              '检索命中 ' +
              formatCount(all.length) +
              ' 条，都不在「' +
              topicLabel +
              '」下。清除主题筛选可以看到全部命中。',
            actionLabel: '清除主题筛选',
            onAction: clearTopic
          });
        } else {
          dom.memoriesMeta.textContent = '语义检索「' + state.query + '」· 0 条';
          showState(dom.memoryState, {
            title: '没有命中的记忆',
            body: 'AI Search 是语义检索，不必与原文逐字一致；换一种说法通常有效，也可以清除搜索回到完整列表。',
            actionLabel: '清除搜索',
            onAction: clearSearch
          });
        }
      } else if (!all.length) {
        dom.memoriesMeta.textContent = '共 0 条';
        showState(dom.memoryState, {
          title: '还没有记忆',
          body: 'dsh 通过 memory_upsert 写入偏好；第一条写入后，这里会出现带版本号的记录。'
        });
      } else {
        dom.memoriesMeta.textContent =
          '共 ' + formatCount(all.length) + ' 条 · 当前筛选 0 条';
        showState(dom.memoryState, {
          title: '「' + topicLabel + '」还没有记忆',
          body: '换一个主题，或清除主题筛选回到全部 ' + formatCount(all.length) + ' 条。',
          actionLabel: '清除主题筛选',
          onAction: clearTopic
        });
      }
      return;
    }

    dom.records.hidden = false;
    hideState(dom.memoryState);

    if (state.view === 'search') {
      dom.memoriesMeta.textContent =
        '语义检索「' +
        state.query +
        '」· 命中 ' +
        formatCount(rows.length) +
        ' 条' +
        (state.topic ? '（已按「' + topicLabel + '」筛选）' : '');
    } else if (state.topic) {
      dom.memoriesMeta.textContent =
        '共 ' + formatCount(all.length) + ' 条 · 主题「' + topicLabel + '」' + formatCount(rows.length) + ' 条';
    } else {
      dom.memoriesMeta.textContent = '共 ' + formatCount(rows.length) + ' 条';
    }

    var fragment = document.createDocumentFragment();
    rows.forEach(function (item) {
      fragment.appendChild(
        el('tr', null, [
          el('td', { class: 'cell-topic', text: labelFor(item.topic) }),
          el('td', {
            class: 'cell-statement',
            text: text(item.statement) || '（这条记录没有陈述）'
          }),
          el('td', {
            class: 'cell-version',
            text:
              typeof item.version === 'number' && item.version > 0
                ? 'v' + item.version
                : '—'
          }),
          el('td', { class: 'cell-time' }, [timeEl(item.updatedAt)])
        ])
      );
    });
    dom.memoryBody.replaceChildren(fragment);
    flagEnter(dom.memoryBody);
  }

  function clearTopic() {
    state.topic = '';
    dom.topicFilter.value = '';
    renderMemories();
    announce('已清除主题筛选');
  }

  function clearSearch() {
    state.searchSeq += 1;
    setSearchBusy(false);
    state.view = 'list';
    state.query = '';
    state.hits = [];
    state.searchError = null;
    if (dom.q.value) dom.q.value = '';
    renderMemories();
    announce('已回到列表模式');
  }

  function setSearchBusy(busy) {
    state.searching = busy;
    dom.searchSubmit.disabled = busy;
    dom.searchSubmit.textContent = busy ? '搜索中…' : '搜索';
    setBusy(dom.memoryBody, busy);
  }

  function runSearch(query) {
    var value = text(query);
    if (!value) {
      clearSearch();
      return Promise.resolve();
    }
    var seq = (state.searchSeq += 1);
    state.query = value;
    state.view = 'search';
    state.searchError = null;
    setSearchBusy(true);
    return request('/v1/recall', {
      method: 'POST',
      body: JSON.stringify({ query: value, limit: RECALL_LIMIT })
    }).then(
      function (data) {
        if (seq !== state.searchSeq) return;
        var items = data && Array.isArray(data.items) ? data.items : [];
        state.hits = hydrateHits(items);
        state.searchError = null;
        setSearchBusy(false);
        renderMemories();
        setBusy(dom.memoryBody, false);
        announce('语义检索完成，命中 ' + state.hits.length + ' 条');
      },
      function (error) {
        if (seq !== state.searchSeq) return;
        noteFatal(error);
        state.hits = [];
        state.searchError = error;
        setSearchBusy(false);
        renderMemories();
        setBusy(dom.memoryBody, false);
        announce('语义检索失败');
      }
    );
  }

  /* -------------------------------------------------------------- pending */

  function loadPending() {
    setBusy(dom.pendingList, true);
    return request('/v1/pending').then(
      function (data) {
        var list = data && Array.isArray(data.pending) ? data.pending : [];
        state.pending = list;
        renderPending(list);
        setBusy(dom.pendingList, false);
      },
      function (error) {
        noteFatal(error);
        dom.pendingMeta.textContent = '读取失败';
        dom.pendingList.hidden = true;
        sectionErrorFrom(dom.pendingState, error, refreshAll);
        setBusy(dom.pendingList, false);
        throw error;
      }
    );
  }

  function renderPending(list) {
    dom.pendingList.replaceChildren();
    dom.pendingMeta.textContent =
      list.length > 0 ? formatCount(list.length) + ' 条待裁决 · 裁决只在 dsh 里执行' : '没有积压';

    if (!list.length) {
      dom.pendingList.hidden = true;
      showState(dom.pendingState, {
        title: '没有待裁决',
        body: '同主题的变更都已处理完毕。下一次 memory_upsert 遇到分歧时，新的条目会出现在这里，等你用 /memory approve 处理。'
      });
      return;
    }

    dom.pendingList.hidden = false;
    hideState(dom.pendingState);

    var fragment = document.createDocumentFragment();
    list.forEach(function (change) {
      fragment.appendChild(buildSlip(change || {}));
    });
    dom.pendingList.appendChild(fragment);
    flagEnter(dom.pendingList);
  }

  function buildSlip(change) {
    var kind = text(change.kind) || 'conflict';
    var kindLabel = KIND_LABELS[kind] || kind;
    var kindClass = KIND_CLASSES[kind] || 'conflict';
    var current = change.current || null;
    var proposed = change.proposed || {};
    var changeId = text(change.changeId);

    var currentStatement = current ? text(current.statement) : '';
    var currentVersion =
      current && typeof current.version === 'number' && current.version > 0
        ? ' · v' + current.version
        : '';
    var proposedStatement = text(proposed.statement);
    var note = el('span', { class: 'copy-note' });

    var head = el('div', { class: 'slip__head' }, [
      el('span', {
        class: 'slip__kind slip__kind--' + kindClass,
        text: kindLabel
      }),
      el('span', { class: 'slip__topic', text: labelFor(change.topic) }),
      timeEl(change.createdAt, 'slip__time')
    ]);

    var sideCurrent = el('div', { class: 'slip__side' }, [
      el('span', { class: 'slip__label', text: '现行' + currentVersion }),
      el('p', {
        class:
          'slip__text' +
          (currentStatement ? ' slip__text--old' : ' slip__text--none'),
        text: currentStatement || '（无现行记录，批准后会新建一条）'
      })
    ]);

    var sideProposed = el('div', { class: 'slip__side' }, [
      el('span', { class: 'slip__label' }, [
        '提议',
        el('span', {
          class: 'slip__conf',
          text: '置信度 ' + formatConfidence(proposed.confidence)
        })
      ]),
      el('p', {
        class: 'slip__text',
        text: proposedStatement || '（这条变更没有提议陈述）'
      })
    ]);

    var foot = el('div', { class: 'slip__foot' }, [
      el('span', { class: 'slip__foot-label', text: 'changeId' }),
      el('code', { class: 'slip__id', text: changeId || '—' }),
      el('button', {
        class: 'btn btn--copy',
        type: 'button',
        text: '复制 changeId',
        disabled: !changeId,
        onclick: function () {
          copyChangeId(changeId, note);
        }
      }),
      note
    ]);

    return el('li', { class: 'slip' }, [
      head,
      el('div', { class: 'slip__pair' }, [sideCurrent, sideProposed]),
      foot
    ]);
  }

  function legacyCopy(value) {
    if (typeof document.execCommand !== 'function') {
      throw new Error('execCommand unavailable');
    }
    var area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    if (typeof area.setSelectionRange === 'function') {
      area.setSelectionRange(0, value.length);
    }
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } finally {
      document.body.removeChild(area);
    }
    if (!ok) throw new Error('copy rejected');
  }

  function copyChangeId(value, note) {
    if (!value) return;
    var write =
      navigator.clipboard && window.isSecureContext
        ? navigator.clipboard.writeText(value)
        : Promise.reject(new Error('clipboard unavailable'));

    write.then(
      function () {
        markCopied(note);
        announce('已复制 changeId：' + value);
      },
      function () {
        try {
          legacyCopy(value);
          markCopied(note);
          announce('已复制 changeId：' + value);
        } catch (error) {
          note.textContent = '复制失败，请手动选中';
          note.classList.add('is-error');
          announce('复制失败，请手动选中 changeId 后复制');
        }
      }
    );
  }

  function markCopied(note) {
    note.textContent = '已复制';
    note.classList.remove('is-error');
    window.setTimeout(function () {
      note.textContent = '';
    }, 4000);
  }

  /* ---------------------------------------------------------------- shell */

  function refreshAll() {
    return loadAll();
  }

  function loadAll() {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    state.fatalError = null;
    dom.refresh.disabled = true;
    dom.refresh.textContent = '更新中…';
    dom.gate.hidden = true;

    var jobs = [
      loadStats(),
      loadHealth(),
      loadTopics(),
      loadMemories(),
      loadPending()
    ];

    return Promise.all(
      jobs.map(function (job) {
        return job.catch(function () {
          return null;
        });
      })
    ).then(function () {
      state.fetchedAt = new Date();
      renderOverviewMeta();
      renderStatus();
      dom.colophonMeta.textContent =
        '数据获取时间 ' + formatTime(state.fetchedAt) + '（本地时区）';
      showGate(state.fatalError);
      dom.refresh.disabled = false;
      dom.refresh.textContent = '刷新';
      state.loading = false;
      announce('数据已更新');
    });
  }

  function renderOverviewMeta() {
    var parts = [];
    if (state.stats) {
      parts.push('最近更新 ' + formatCount(state.recentItems.length) + ' 条');
    } else {
      parts.push('概览读取失败');
    }
    if (state.fetchedAt) {
      parts.push('获取于 ' + formatClock(state.fetchedAt));
    }
    dom.overviewMeta.textContent = parts.join(' · ');
  }

  function cacheDom() {
    var map = {
      refresh: 'refresh',
      gate: 'gate',
      gateTitle: 'gate-title',
      gateBody: 'gate-body',
      gateRetry: 'gate-retry',
      live: 'live',
      overviewMeta: 'overview-meta',
      totals: 'totals',
      statMemories: 'stat-memories',
      statPending: 'stat-pending',
      statPendingNote: 'stat-pending-note',
      statTopics: 'stat-topics',
      statSearch: 'stat-search',
      statSearchNote: 'stat-search-note',
      recent: 'recent',
      recentState: 'recent-state',
      status: 'status',
      memoriesMeta: 'memories-meta',
      searchForm: 'search-form',
      q: 'q',
      searchSubmit: 'search-submit',
      searchClear: 'search-clear',
      topicFilter: 'topic-filter',
      searchMode: 'search-mode',
      records: 'records',
      memoryBody: 'memory-body',
      memoryState: 'memory-state',
      pendingMeta: 'pending-meta',
      pendingList: 'pending-list',
      pendingState: 'pending-state',
      topicsMeta: 'topics-meta',
      topicList: 'topic-list',
      topicState: 'topic-state',
      colophonMeta: 'colophon-meta'
    };
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      dom[key] = document.getElementById(map[key]);
    }
  }

  function bindEvents() {
    dom.refresh.addEventListener('click', function () {
      loadAll();
    });

    dom.gateRetry.addEventListener('click', function () {
      loadAll();
    });

    dom.searchForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var value = dom.q.value.trim();
      if (!value) {
        clearSearch();
        return;
      }
      runSearch(value);
    });

    dom.searchClear.addEventListener('click', function () {
      clearSearch();
    });

    dom.q.addEventListener('input', function () {
      if (state.view === 'search' && !dom.q.value.trim()) {
        clearSearch();
      }
    });

    dom.topicFilter.addEventListener('change', function () {
      state.topic = dom.topicFilter.value;
      renderMemories();
      announce(
        state.topic ? '已筛选主题：' + labelFor(state.topic) : '已取消主题筛选'
      );
    });
  }

  /* 导航高亮跟随滚动位置，而不是视口中线：停在页首时高亮必须是「概览」。 */
  function initScrollSpy() {
    var links = Array.prototype.slice.call(
      document.querySelectorAll('.sections__link')
    );
    if (!links.length) return;
    var sections = links
      .map(function (link) {
        return document.getElementById(link.dataset.nav);
      })
      .filter(Boolean);
    if (!sections.length) return;

    var ticking = false;

    function activate() {
      ticking = false;
      var probe = window.scrollY + 140;
      var activeId = sections[0].id;
      for (var i = 0; i < sections.length; i += 1) {
        var top = sections[i].getBoundingClientRect().top + window.scrollY;
        if (top <= probe) activeId = sections[i].id;
      }
      /* 到底部时最后一段可能够不到判定线，直接高亮它。 */
      var atBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 40;
      if (atBottom) activeId = sections[sections.length - 1].id;

      links.forEach(function (link) {
        if (link.dataset.nav === activeId) {
          link.setAttribute('aria-current', 'true');
        } else {
          link.removeAttribute('aria-current');
        }
      });
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(activate);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    activate();
  }

  function init() {
    cacheDom();
    if (!dom.searchForm || !dom.memoryBody) return;
    bindEvents();
    initScrollSpy();
    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
