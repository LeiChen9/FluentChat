import webpush from "web-push";

export default {
  async fetch(request, env) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/send") {
      return new Response("Not found", { status: 404 });
    }
    const { subscription, payload } = await request.json();
    webpush.setVapidDetails(
      "mailto:chenlei9691@gmail.com", env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY,
    );
    try {
      const result = await webpush.sendNotification(subscription, JSON.stringify(payload));
      return Response.json({ statusCode: result.statusCode });
    } catch (error) {
      return Response.json({
        statusCode: error.statusCode || 502,
        error: String(error.body || error).slice(0, 150),
      }, { status: 200 });
    }
  },
};
