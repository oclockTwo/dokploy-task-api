import { NextRequest, NextResponse } from "next/server";

type UpdateTaskReqBody = {
  taskId: string;
  trackIds: string[];
  callbackUrl: string;
};

type Song = {
  id: string;
  image_path: string | null;
  error_code: string | null;
  error_detail: string | null;
  song_path: string | null;
  finished: boolean;
  lyrics: string | null;
  title: string;
  tags: string[];
  created_at: string;
  duration: number;
  prompt: string;
};

type SongsResponse = {
  songs: Song[];
};

type CallbackSongData = {
  id: string;
  audio_url: string;
  image_url: string;
  prompt: string;
  model_name: string;
  title: string;
  tags: string;
  createTime: string;
  duration: number;
  status: string;
  error_message?: string | null;
};

type CallbackSuccessData = {
  code: 200;
  msg: string;
  data: {
    callbackType: "complete";
    task_id: string;
    data: CallbackSongData[];
  };
};

type CallbackErrorData = {
  code: 501;
  msg: string;
  detail: string;
  data: {
    callbackType: "complete";
    task_id: string;
    data: CallbackSongData[];
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_RETRY_TIME = 10 * 60 * 1000; // 10分钟，单位毫秒
const RETRY_INTERVAL = 10000; // 10秒重试间隔

const GPTGOD_MUSIC_API_TOKEN = process.env.GPTGOD_MUSIC_API_TOKEN || ""; // 从环境变量获取 token

async function checkSongs(
  trackIds: string[],
  retryCount = 5
): Promise<SongsResponse> {
  try {
    const response = await fetch(
      `https://api.gptgod.online/udio/songs?songIds=${trackIds.join(",")}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GPTGOD_MUSIC_API_TOKEN}`,
        },
      }
    );

    if (!response.ok) {
      const errorMessage = await response.json();
      throw new Error(`Failed to fetch songs: ${JSON.stringify(errorMessage)}`);
    }

    return response.json();
  } catch (error) {
    console.error(`Attempt failed:`, error);
  }

  // TypeScript 需要这个返回语句，实际上代码不会执行到这里
  throw new Error("Unreachable code");
}

async function callbackWithRetry(
  url: string,
  data: CallbackSuccessData | CallbackErrorData,
  maxRetries = 3
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GPTGOD_MUSIC_API_TOKEN}`,
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        throw new Error(`Callback failed with status: ${response.status}`);
      }

      return true; // 成功返回
    } catch (error) {
      console.error(`Callback attempt ${i + 1} failed:`, error);

      if (i === maxRetries - 1) {
        console.error("All callback retries failed");
        return false;
      }

      // 指数退避：10s, 20s, 40s
      const delay = Math.pow(2, i) * 10000;
      await sleep(delay);
    }
  }

  return false;
}

export async function POST(req: NextRequest) {
  try {
    const body: UpdateTaskReqBody = await req.json();
    const { trackIds, callbackUrl, taskId } = body;

    const startTime = Date.now();
    let allFinished = false;
    let data: SongsResponse;

    while (!allFinished && Date.now() - startTime < MAX_RETRY_TIME) {
      data = await checkSongs(trackIds);
      allFinished = data.songs.every(
        (song) =>
          (song.song_path !== null && song.song_path !== "") ||
          (song.error_code !== null && song.error_code !== "")
      );

      if (allFinished) {
        // 检查是否所有歌曲都失败
        const allFailed = data.songs.every((song) => song.error_code !== null);

        // 构建回调数据
        const callbackSongs: CallbackSongData[] = data.songs.map((song) => ({
          id: song.id,
          audio_url: song.song_path || "",
          image_url: song.image_path || "",
          prompt: song.lyrics || "",
          model_name: "udio",
          title: song.title || "",
          tags: song.tags?.join(",") || "",
          createTime: new Date(song.created_at)
            .toISOString()
            .replace("T", " ")
            .slice(0, 19),
          duration: song.duration,
          status: song.error_code ? "501" : "200",
          error_message: song.error_detail,
        }));

        const callbackData = allFailed // 只有全部失败才返回错误状态
          ? ({
              code: 501,
              msg: data.songs[0].error_detail || "All songs generation failed",
              detail: data.songs[0].error_code || "All songs generation failed",
              data: {
                callbackType: "complete",
                task_id: taskId,
                data: callbackSongs,
              },
            } as CallbackErrorData)
          : ({
              code: 200,
              msg: "Generated successfully.",
              data: {
                callbackType: "complete",
                task_id: taskId,
                data: callbackSongs,
              },
            } as CallbackSuccessData);

        // 使用新的回调函数替换原来的 fetch 调用
        const callbackSuccess = await callbackWithRetry(
          callbackUrl,
          callbackData
        );

        return NextResponse.json({
          status: "success",
          message: allFailed ? "All songs failed" : "Process completed",
          callbackSuccess, // 添加回调状态到响应中
        });
      }

      if (!allFinished && Date.now() - startTime < MAX_RETRY_TIME) {
        await sleep(RETRY_INTERVAL);
      }
    }

    return NextResponse.json({
      status: "timeout",
      message: "Processing timeout after 10 minutes",
    });
  } catch (error) {
    console.error("Error processing request:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
