import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3"
import { assert, describe, it, vi } from "@effect/vitest"
import { Effect } from "effect"
import { fromS3 } from "../src/R2S3Transport.js"

const bytes = (value: string) => new TextEncoder().encode(value)

const text = (value: Uint8Array) => new TextDecoder().decode(value)

describe("S3 transport", () => {
  it.effect("should send an ETag condition when writing through the S3 client", () =>
    Effect.gen(function*() {
      const commands: Array<PutObjectCommand> = []

      const fake = new S3Client({
        region: "auto",
        endpoint: "https://example.invalid",
        credentials: {
          accessKeyId: "test",
          secretAccessKey: "test"
        }
      })

      vi.spyOn(fake, "send").mockImplementation((command) => {
        if (command instanceof GetObjectCommand) {
          return Promise.resolve({
            Body: { transformToByteArray: () => Promise.resolve(bytes("stored")) },
            ETag: "\"first\"",
            Metadata: { generation: "0", digest: "test" }
          })
        }

        if (command instanceof PutObjectCommand) {
          commands.push(command)

          return Promise.resolve({ ETag: "\"second\"" })
        }

        throw new Error("unexpected S3 command")
      })

      const client = fromS3(fake, "bucket")
      assert.strictEqual(text((yield* client.read("key"))!.bytes), "stored")
      yield* client.write("key", bytes("next"), "1", "digest", { ifMatch: "\"first\"" })
      assert.strictEqual(commands[0]?.input.IfMatch, "\"first\"")
      assert.strictEqual(commands[0]?.input.Metadata?.["generation"], "1")
      fake.destroy()
    }))

  it.effect("should return absence when S3 reports a missing key", () =>
    Effect.gen(function*() {
      const fake = new S3Client({
        region: "auto",
        endpoint: "https://example.invalid",
        credentials: {
          accessKeyId: "test",
          secretAccessKey: "test"
        }
      })

      const send = vi.spyOn(fake, "send")
      send.mockRejectedValue(
        new S3ServiceException({
          name: "NoSuchKey",
          $fault: "client",
          $metadata: { httpStatusCode: 404 }
        })
      )
      assert.strictEqual(yield* fromS3(fake, "bucket").read("key"), null)

      fake.destroy()
    }))

  it.effect("should report an error when S3 reports a missing bucket", () =>
    Effect.gen(function*() {
      const fake = new S3Client({
        region: "auto",
        endpoint: "https://example.invalid",
        credentials: {
          accessKeyId: "test",
          secretAccessKey: "test"
        }
      })

      const send = vi.spyOn(fake, "send")
      send.mockRejectedValue(
        new S3ServiceException({
          name: "NoSuchBucket",
          $fault: "client",
          $metadata: { httpStatusCode: 404 }
        })
      )
      const error = yield* Effect.flip(fromS3(fake, "bucket").read("key"))
      assert.strictEqual(error.cause instanceof S3ServiceException && error.cause.name, "NoSuchBucket")
      assert.strictEqual(error.operation, "R2LiveImageStore.fromS3")
      fake.destroy()
    }))
  it.effect("should use the selected bucket when an S3 adapter is constructed in either call style", () =>
    Effect.gen(function*() {
      const commands: Array<GetObjectCommand | PutObjectCommand> = []

      const fake = new S3Client({
        region: "auto",
        endpoint: "https://example.invalid",
        credentials: { accessKeyId: "test", secretAccessKey: "test" }
      })

      vi.spyOn(fake, "send").mockImplementation((command) => {
        if (command instanceof GetObjectCommand) {
          commands.push(command)

          return Promise.resolve({
            Body: { transformToByteArray: () => Promise.resolve(bytes("stored")) },
            ETag: "\"first\"",
            Metadata: { generation: "0", digest: "test" }
          })
        }

        if (command instanceof PutObjectCommand) {
          commands.push(command)

          return Promise.resolve({ ETag: "\"second\"" })
        }

        throw new Error("unexpected S3 command")
      })

      const inBucket = fromS3("selected-bucket")

      for (const client of [fromS3(fake, "selected-bucket"), inBucket(fake)]) {
        assert.strictEqual(text((yield* client.read("key"))!.bytes), "stored")
        assert.deepStrictEqual(
          yield* client.write("key", bytes("next"), "1", "digest", { ifMatch: "\"first\"" }),
          { etag: "\"second\"" }
        )
      }

      assert.deepStrictEqual(commands.map((command) => command.input.Bucket), Array(4).fill("selected-bucket"))
      assert.deepStrictEqual(commands.map((command) => command.input.Key), Array(4).fill("key"))
      fake.destroy()
    }))
})
