import { AsyncLocalStorage, AsyncResource } from "async_hooks"

export namespace Context {
  export class NotFound extends Error {
    constructor(public override readonly name: string) {
      super(`No context found for ${name}`)
    }
  }

  export function create<T>(name: string) {
    const storage = new AsyncLocalStorage<T>()
    return {
      use() {
        const result = storage.getStore()
        if (!result) {
          throw new NotFound(name)
        }
        return result
      },
      provide<R>(value: T, fn: () => R) {
        // WebContainer's Node compatibility can be flaky with async_hooks propagation
        // across promise boundaries. Running `fn` inside an AsyncResource helps
        // preserve the AsyncLocalStorage store for downstream awaits.
        return storage.run(value, () => {
          const resource = new AsyncResource(`context:${name}`)
          return resource.runInAsyncScope(fn)
        })
      },
    }
  }
}
