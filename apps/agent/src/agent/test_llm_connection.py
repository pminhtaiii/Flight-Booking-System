"""
Mimo LLM API Connection Diagnostic Tool

Question being answered:
Can the user access the Mimo LLM API endpoint from their local environment using a valid API key input from the terminal?
Is the failure due to key validity, endpoint/DNS, or local config?

Usage:
    uv run python src/agent/test_llm_connection.py
"""

import argparse
import getpass
import os
import sys
import time
import traceback
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Prevent shadowing standard library packages (like 'queue') by removing the script's directory from sys.path
script_dir = Path(__file__).resolve().parent
if str(script_dir) in sys.path:
    sys.path.remove(str(script_dir))

# Ensure the 'src' directory is in sys.path to resolve 'agent' package imports correctly
agent_root = script_dir.parent.parent
src_dir = agent_root / "src"
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))


def main():
    # 1. Load the environment variables from .env
    script_dir = Path(__file__).resolve().parent
    agent_root = script_dir.parent.parent
    env_path = agent_root / ".env"

    if env_path.exists():
        load_dotenv(dotenv_path=env_path)
        print(f"\033[2mLoaded environment from {env_path}\033[0m")
    else:
        print("\033[2mNo local .env file found at agent root. Proceeding with defaults.\033[0m")

    env_url = os.getenv("MIMO_API_URL", "https://token-plan-sgp.xiaomimimo.com/v1")
    env_key = os.getenv("MIMO_API_KEY", "")
    env_model = os.getenv("MIMO_MODEL_NAME", "mimo")

    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Mimo LLM API Connection Diagnostic Tool")
    parser.add_argument("-k", "--key", "--api-key", help="Mimo API Key")
    parser.add_argument("-u", "--url", "--api-url", help="Mimo API Base URL")
    parser.add_argument("-m", "--model", help="Mimo Model Name")
    parser.add_argument(
        "--visible",
        action="store_true",
        help="Prompt with visible text input instead of hidden password prompt",
    )
    args = parser.parse_args()

    # 2. Render Header
    print("\033[1;36m==================================================\033[0m")
    print("\033[1;36m           Mimo LLM Diagnostic Utility           \033[0m")
    print("\033[1;36m==================================================\033[0m")

    # 3. Prompt for API Key
    api_key = args.key
    if not api_key:
        if env_key:
            masked_env_key = f"{env_key[:6]}...{env_key[-4:]}" if len(env_key) > 10 else "..."
            key_prompt = f"Mimo API Key (Press Enter to use env key [{masked_env_key}]): "
        else:
            key_prompt = "Mimo API Key: "

        if args.visible:
            prompt_key = input(key_prompt).strip()
        else:
            print(
                "\033[2mNote: Your typing is hidden/masked for security. Type or paste your key and hit Enter.\033[0m"
            )
            prompt_key = getpass.getpass(key_prompt).strip()

        api_key = prompt_key if prompt_key else env_key

    if not api_key:
        print(
            "\033[1;31mError: No API key provided! Please pass one or configure it in .env.\033[0m"
        )
        sys.exit(1)

    # 4. Prompt for API Base URL
    api_url = args.url
    if not api_url:
        prompt_url = input(f"Mimo API Base URL [{env_url}]: ").strip()
        api_url = prompt_url if prompt_url else env_url

    # 5. Prompt for Model Name
    model_name = args.model
    if not model_name:
        prompt_model = input(f"Mimo Model Name [{env_model}]: ").strip()
        model_name = prompt_model if prompt_model else env_model

    # 6. Test 1: Direct HTTP Request via httpx
    print("\n\033[1;35m--- Test 1: Direct HTTP Connection via httpx ---\033[0m")
    completion_url = f"{api_url.rstrip('/')}/chat/completions"
    print(f"\033[2mTarget Endpoint: {completion_url}\033[0m")

    masked_key = f"{api_key[:6]}...{api_key[-4:]}" if len(api_key) > 10 else "..."
    print(f"\033[2mUsing API Key:   {masked_key}\033[0m")
    print(f"\033[2mModel Name:      {model_name}\033[0m")

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model_name,
        "messages": [
            {"role": "user", "content": "Hello, please respond with the exact word: Connected!"}
        ],
        "max_tokens": 15,
        "temperature": 0.0,
    }

    test_1_ok = False
    try:
        start_time = time.time()
        print("Sending HTTP request...")
        response = httpx.post(completion_url, json=payload, headers=headers, timeout=10.0)
        latency = time.time() - start_time

        print(f"HTTP Status Code: {response.status_code}")
        print(f"Latency:          {latency:.2f} seconds")

        if response.status_code == 200:
            print("\033[1;32m[SUCCESS] Direct HTTP Connection Succeeded!\033[0m")
            res_data = response.json()
            try:
                content = res_data["choices"][0]["message"]["content"]
                print(f"Response Content: \033[1m{content}\033[0m")
            except (KeyError, IndexError):
                print(
                    "\033[1;33m[WARNING] Warning: Succeeded, but response structure is unexpected.\033[0m"
                )
                print(f"Response JSON: {res_data}")
            test_1_ok = True
        else:
            print("\033[1;31m[FAILED] Direct HTTP Connection Failed!\033[0m")
            print(f"Error Content: {response.text}")
            # Diagnostic suggestions
            if response.status_code == 401:
                print(
                    "\033[1;31mSuggestion: 401 Unauthorized. The API key you provided is invalid or has expired.\033[0m"
                )
            elif response.status_code == 404:
                print(
                    "\033[1;31mSuggestion: 404 Not Found. Please verify the Base URL. It usually needs to end with '/v1'.\033[0m"
                )
            elif response.status_code == 429:
                print(
                    "\033[1;31mSuggestion: 429 Too Many Requests. You may have exceeded your rate limits or billing quota.\033[0m"
                )
            else:
                print(
                    f"\033[1;31mSuggestion: Received error status code {response.status_code}. Check API key and endpoint configuration.\033[0m"
                )

    except httpx.ConnectError as e:
        print("\033[1;31m[FAILED] Direct HTTP Connection Failed!\033[0m")
        print(f"Connection Error: {e}")
        print(
            "\033[1;31mSuggestion: Could not connect to the server. Check your internet connection, DNS resolution, proxies, or firewalls.\033[0m"
        )
    except httpx.TimeoutException as e:
        print("\033[1;31m[FAILED] Direct HTTP Connection Failed!\033[0m")
        print(f"Timeout Error: {e}")
        print(
            "\033[1;31mSuggestion: Request timed out. The server might be down or slow, or you might be facing network blockages.\033[0m"
        )
    except Exception as e:
        print("\033[1;31m[FAILED] Direct HTTP Connection Failed!\033[0m")
        print(f"Unexpected Error: {e}")
        traceback.print_exc()

    # 7. Test 2: LangChain ChatOpenAI Connection
    print("\n\033[1;35m--- Test 2: LangChain ChatOpenAI Connection ---\033[0m")
    test_2_ok = False
    try:
        from langchain_core.messages import HumanMessage
        from langchain_openai import ChatOpenAI

        print("Initializing LangChain ChatOpenAI client...")
        chat_model = ChatOpenAI(
            base_url=api_url,
            api_key=api_key,
            model=model_name,
            streaming=False,
        )

        print("Invoking LangChain ChatOpenAI with test prompt...")
        start_time = time.time()
        response = chat_model.invoke(
            [HumanMessage(content="Hello, please respond with the exact word: Connected!")]
        )
        latency = time.time() - start_time

        print(f"Latency:          {latency:.2f} seconds")
        print("\033[1;32m[SUCCESS] LangChain Connection Succeeded!\033[0m")
        print(f"Response Content: \033[1m{response.content}\033[0m")
        if hasattr(response, "response_metadata") and response.response_metadata:
            print(f"\033[2mResponse Metadata: {response.response_metadata}\033[0m")
        test_2_ok = True
    except Exception as e:
        print("\033[1;31m[FAILED] LangChain Connection Failed!\033[0m")
        print(f"Error: {e}")
        traceback.print_exc()
        print(
            "\033[1;31mSuggestion: LangChain failed to invoke the model. Ensure dependencies are correctly installed and matching the API configuration.\033[0m"
        )

    # 8. Summary Status
    print("\n\033[1;36m==================================================\033[0m")
    if test_1_ok and test_2_ok:
        print("\033[1;32m      STATUS: BOTH TESTS PASSED SUCCESSFULLY!     \033[0m")
        print("\033[1;32m      The API Key and endpoint connection are OK. \033[0m")
    elif test_1_ok and not test_2_ok:
        print("\033[1;33m      STATUS: PARTIAL SUCCESS (HTTP OK, LangChain FAILED) \033[0m")
        print(
            "\033[1;33m      The API is working, but the LangChain client configuration is faulty. \033[0m"
        )
    else:
        print("\033[1;31m      STATUS: FAILURE                               \033[0m")
        print("\033[1;31m      Please check your Mimo API Key and Base URL.  \033[0m")
    print("\033[1;36m==================================================\033[0m")


if __name__ == "__main__":
    main()
