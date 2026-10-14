module.exports = {
  apps: [
    {
      name: "WardogsBot",
      script: "./dist/index.js",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
