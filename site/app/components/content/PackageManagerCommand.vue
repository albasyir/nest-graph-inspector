<script setup lang="ts">
import ProsePre from '@nuxt/ui/components/prose/Pre.vue'
import ProseCodeGroup from '~/components/ProseCodeGroup.vue'
import {
  getPackageManagerCommand,
  isPackageManagerCommandSet,
  supportedPackageManagers
} from '~/utils/supported-runtime'
import type { PackageManagerCommandSet } from '~/utils/supported-runtime'

const props = withDefaults(defineProps<{
  command?: PackageManagerCommandSet | string
}>(), {
  command: 'install'
})

const commandSet = computed<PackageManagerCommandSet>(() => {
  if (isPackageManagerCommandSet(props.command)) {
    return props.command
  }

  return 'install'
})

const commands = computed(() => supportedPackageManagers.map(packageManager => ({
  packageManager,
  command: getPackageManagerCommand(commandSet.value, packageManager)
})))
</script>

<template>
  <ProseCodeGroup>
    <ProsePre
      v-for="item in commands"
      :key="item.packageManager"
      language="bash"
      :filename="item.packageManager"
      :code="item.command"
    >
      <code>{{ item.command }}</code>
    </ProsePre>
  </ProseCodeGroup>
</template>
