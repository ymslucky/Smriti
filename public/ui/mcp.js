/**
 * MCP 接入教程页的复制按钮。
 *
 * 只做一件事：把指定代码块（`<code id="…">`）的纯文本写进剪贴板，并在
 * 代码块里就地反馈。失败时降级到隐藏 textarea + execCommand，再失败就
 * 选中代码文本并提示手动复制——不弹窗、不引入依赖、不碰 innerHTML。
 */
(function () {
  'use strict'

  var buttons = document.querySelectorAll('[data-copy-target]')
  if (buttons.length === 0) return

  function statusFor(button) {
    var figure = button.closest('.code')
    return figure ? figure.querySelector('.code__status') : null
  }

  function setStatus(button, message, isError) {
    var status = statusFor(button)
    if (!status) return
    status.textContent = message
    status.classList.toggle('is-error', Boolean(isError))
  }

  function selectText(node) {
    var range = document.createRange()
    range.selectNodeContents(node)
    var selection = window.getSelection()
    if (!selection) return
    selection.removeAllRanges()
    selection.addRange(range)
  }

  function copyWithTextarea(text) {
    var area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.left = '-1000px'
    document.body.appendChild(area)
    area.select()
    var copied = false
    try {
      copied = document.execCommand('copy')
    } catch (error) {
      copied = false
    }
    area.remove()
    return copied
  }

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true
        },
        function () {
          return copyWithTextarea(text)
        },
      )
    }
    return Promise.resolve(copyWithTextarea(text))
  }

  Array.prototype.forEach.call(buttons, function (button) {
    var timer = 0

    button.addEventListener('click', function () {
      var target = document.getElementById(button.getAttribute('data-copy-target') || '')
      if (!target) {
        setStatus(button, '复制失败，请手动选中', true)
        return
      }

      copy(target.textContent || '').then(function (copied) {
        if (copied) {
          setStatus(button, '已复制', false)
          window.clearTimeout(timer)
          timer = window.setTimeout(function () {
            setStatus(button, '', false)
          }, 4000)
          return
        }
        setStatus(button, '复制失败，请手动选中', true)
        selectText(target)
      })
    })
  })
})()
