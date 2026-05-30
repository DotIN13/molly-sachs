declare const __API_URL__: string
declare const __PLATFORM__: string

export const API_URL: string = typeof __API_URL__ !== 'undefined' ? __API_URL__ : 'http://localhost:8000'

export const PLATFORM: string = typeof __PLATFORM__ !== 'undefined' ? __PLATFORM__ : 'electron'

export const isElectron: boolean = PLATFORM === 'electron'
export const isWeb: boolean = PLATFORM === 'web'
