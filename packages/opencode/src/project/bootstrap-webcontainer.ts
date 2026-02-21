import { Instance } from "./instance"
import { Log } from "@/util/log"
import { Truncate } from "@/tool/truncation"

export async function InstanceBootstrapWebcontainer() {
  Log.Default.info("bootstrapping (webcontainer)", { directory: Instance.directory })
  Truncate.init()
}

