// 让 TypeScript 认识 Vite 的 ?raw 导入（把文件内容当字符串打包进来）
declare module '*?raw' {
  const content: string
  export default content
}
