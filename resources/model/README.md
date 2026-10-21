# 동봉 모델 위치

`npm run dist:win` **전에** 이 폴더에 `.gguf` 파일을 하나 넣으세요.
설치본에 함께 포장되어, 사용자는 아무것도 지정하지 않아도 바로 씁니다.

```
resources/model/qwen2.5-3b-instruct-q4_k_m.gguf
```

- 파일이 여러 개면 이름순 첫 번째를 씁니다.
- 이 폴더의 `.gguf` 는 저장소에 커밋하지 않습니다(.gitignore).
- 개발 중(`npm run dev`)에도 이 폴더를 그대로 읽습니다.

Ollama 를 쓰신 적이 있으면 받아 둔 모델을 복사해도 됩니다 —
`%USERPROFILE%\.ollama\models\blobs\` 안의 큰 파일이 gguf 원본입니다.
확장자를 `.gguf` 로 바꿔서 넣으세요.
