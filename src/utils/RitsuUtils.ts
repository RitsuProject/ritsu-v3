import { AxiosError } from 'axios'

export default {
  randomIntBetween(min: number, max: number) {
    min = Math.ceil(min)
    max = Math.floor(max)
    return Math.floor(Math.random() * (max - min) + min)
  },

  randomValueInArray<T extends unknown>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)]
  },

  isAxiosError(err: unknown): err is AxiosError {
    return (err as AxiosError).isAxiosError
  },
}
