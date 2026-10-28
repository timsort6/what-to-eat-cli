export interface Throttle {
  /** 有新内容：冷却期外立即执行，冷却期内只标记，冷却结束时执行一次。 */
  push(): void
  /** 清除冷却与待执行标记后立即执行一次。 */
  flush(): void
  /** 清除冷却与待执行标记，之后不会有迟到执行。 */
  cancel(): void
}

/** 每个 wait 窗口最多执行一次 run；不依赖时钟，只依赖 setTimeout。 */
export function createThrottle(run: () => void, wait: number): Throttle {
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = false
  const cool = (): void => {
    timer = setTimeout(() => {
      timer = undefined
      if (!dirty) return
      dirty = false
      run()
      cool()
    }, wait)
  }
  const cancel = (): void => {
    clearTimeout(timer)
    timer = undefined
    dirty = false
  }
  return {
    push() {
      if (timer !== undefined) {
        dirty = true
        return
      }
      run()
      cool()
    },
    flush() {
      cancel()
      run()
    },
    cancel,
  }
}
