import OpenAI from "openai";
import { config } from 'dotenv';
config()
export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
console.log(process.env.OPENAI_KEY)
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
})