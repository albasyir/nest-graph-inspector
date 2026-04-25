import { defineStore } from 'pinia'
import {
  defaultPackageManager,
  isSupportedPackageManager,
  supportedPackageManagers
} from '~/utils/supported-runtime'
import type { PackageManager } from '~/utils/supported-runtime'

export { supportedPackageManagers as packageManagers }
export { isSupportedPackageManager as isPackageManager }

const selectedPackageManagerStorageKey = 'nest-graph-inspector-package-manager'

export const usePackageManagerStore = defineStore('package-manager', {
  state: () => ({
    selectedPackageManager: defaultPackageManager as PackageManager
  }),

  actions: {
    hydrateFromStorage() {
      if (!import.meta.client) {
        return
      }

      const value = localStorage.getItem(selectedPackageManagerStorageKey)
      if (value && isSupportedPackageManager(value)) {
        this.selectedPackageManager = value
      }
    },

    setPackageManager(value: PackageManager) {
      this.selectedPackageManager = value

      if (import.meta.client) {
        localStorage.setItem(selectedPackageManagerStorageKey, value)
      }
    }
  }
})
